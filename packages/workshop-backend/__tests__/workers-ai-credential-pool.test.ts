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
    const captured: { accountId: string; authorization: string | null; headers: Headers }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const accountId = new URL(request.url).pathname.split("/")[4];
      captured.push({
        accountId,
        authorization: request.headers.get("authorization"),
        headers: request.headers,
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
});
