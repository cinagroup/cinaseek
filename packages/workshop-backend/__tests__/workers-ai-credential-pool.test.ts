import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkersAiCredentialPool } from "../src/workers-ai-credential-pool.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_WORKERS_AI_POOL: DurableObjectNamespace<WorkersAiCredentialPool>;
  }
}

const ACCOUNT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_A = "workers-ai-token-a-1234567890";
const TOKEN_B = "workers-ai-token-b-1234567890";
const SPEECH_MODEL = "@cf/openai/whisper-large-v3-turbo";

function inferenceRequest(): Request {
  return new Request("https://workers-ai-pool.invalid/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-affinity": "chat-7",
      "x-not-forwarded": "private",
    },
    body: JSON.stringify({ model: "@cf/zai-org/glm-5.2", messages: [] }),
  });
}

describe("WorkersAiCredentialPool", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("routes least-recently-used credentials and skips one after rate limiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const captured: {
      accountId: string;
      authorization: string | null;
      headers: Headers;
      redirect: string | undefined;
    }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const accountId = new URL(request.url).pathname.split("/")[4];
      captured.push({
        accountId,
        authorization: request.headers.get("authorization"),
        headers: request.headers,
        redirect: init?.redirect,
      });
      await request.text();
      return captured.length === 3
        ? Response.json({ error: "rate limited" }, { status: 429 })
        : Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stub = env.TEST_WORKERS_AI_POOL.getByName("glm-5.2-routing");
    await runInDurableObject(stub, async (pool: WorkersAiCredentialPool) => {
      pool.upsert("owner-a", ACCOUNT_A, TOKEN_A);
      pool.upsert("owner-b", ACCOUNT_B, TOKEN_B);

      vi.setSystemTime(2_000);
      expect((await pool.run(inferenceRequest())).status).toBe(200);
      vi.setSystemTime(2_001);
      expect((await pool.run(inferenceRequest())).status).toBe(200);
      vi.setSystemTime(2_002);
      expect((await pool.run(inferenceRequest())).status).toBe(429);
      vi.setSystemTime(2_003);
      expect((await pool.run(inferenceRequest())).status).toBe(200);

      expect(pool.status()).toEqual({ total: 2, available: 1 });
    });

    expect(captured.map(entry => entry.accountId)).toEqual([
      ACCOUNT_A, ACCOUNT_B, ACCOUNT_A, ACCOUNT_B,
    ]);
    expect(captured.map(entry => entry.authorization)).toEqual([
      `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`, `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`,
    ]);
    expect(captured[0].headers.get("x-session-affinity")).toBe("chat-7");
    expect(captured[0].headers.get("x-not-forwarded")).toBeNull();
    expect(captured.every(entry => entry.redirect === "manual")).toBe(true);
  });

  it("validates credentials and reports only aggregate pool state", async () => {
    const stub = env.TEST_WORKERS_AI_POOL.getByName("credential-validation");
    await runInDurableObject(stub, async (pool: WorkersAiCredentialPool) => {
      expect(() => pool.upsert("owner", "not-an-account", TOKEN_A))
          .toThrow("32 hexadecimal characters");
      expect(() => pool.upsert("owner", ACCOUNT_A, "short"))
          .toThrow("invalid format");

      pool.upsert("owner", ACCOUNT_A.toUpperCase(), `  ${TOKEN_A}  `);
      expect(pool.status()).toEqual({ total: 1, available: 1 });
      pool.remove("owner");
      expect(pool.status()).toEqual({ total: 0, available: 0 });
    });
  });

  it("routes speech with timing metadata and enforces the credential audio quota", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 30, 12));
    const captured: Array<{
      accountId: string;
      authorization: string | null;
      body: Record<string, unknown>;
      redirect: string | undefined;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      captured.push({
        accountId: new URL(request.url).pathname.split("/")[4],
        authorization: request.headers.get("authorization"),
        body: await request.json() as Record<string, unknown>,
        redirect: init?.redirect,
      });
      return Response.json({
        success: true,
        result: {
          transcription_info: { text: "hello", language: "en", duration: 2.4 },
          segments: [{ text: "hello", start: 0.1, end: 0.8 }],
        },
      });
    }));

    const stub = env.TEST_WORKERS_AI_POOL.getByName(SPEECH_MODEL);
    await runInDurableObject(stub, async (pool: WorkersAiCredentialPool) => {
      pool.upsert("owner-a", ACCOUNT_A, TOKEN_A);
      pool.upsert("owner-b", ACCOUNT_B, TOKEN_B);

      const first = await pool.transcribe(
          SPEECH_MODEL, new Blob([new Uint8Array([1, 2])]), 2.4,
          { language: "en", wordTimestamps: true });
      const second = await pool.transcribe(
          SPEECH_MODEL, new Blob([new Uint8Array([3])]), 1,
          { wordTimestamps: false });
      expect(first).toEqual({
        text: "hello",
        language: "en",
        durationSeconds: 2.4,
        modelId: SPEECH_MODEL,
        words: [{ text: "hello", startSeconds: 0.1, endSeconds: 0.8 }],
      });
      expect(second.words).toBeUndefined();
      expect(pool.speechStatus()).toEqual({ total: 2, available: 2 });

      const state = (pool as unknown as { ctx: DurableObjectState }).ctx;
      expect(state.storage.sql.exec<{ total: number }>(
          "SELECT SUM(daily_audio_seconds) AS total FROM credentials").one().total).toBe(6);
      state.storage.sql.exec(
          "UPDATE credentials SET daily_audio_day = ?, daily_audio_seconds = ?",
          "2026-08-30", 2 * 60 * 60);
      expect(pool.speechStatus()).toEqual({ total: 2, available: 0 });
      await expect(pool.transcribe(
          SPEECH_MODEL, new Blob([new Uint8Array([4])]), 1)).rejects
          .toThrow("No shared Workers AI speech credential is available");
    });

    expect(captured.map(entry => entry.accountId)).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(captured.map(entry => entry.authorization)).toEqual([
      `Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`,
    ]);
    expect(captured[0].body).toMatchObject({ language: "en", vad_filter: true });
    expect(captured.every(entry => entry.redirect === "manual")).toBe(true);
  });
});
