import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkersAiApi,
  WorkersAiApiError,
  normalizeWorkersAiCredentials,
  normalizeWorkersAiModelId,
} from "../src/workers-ai-api.js";

const CREDENTIALS = {
  accountId: "0123456789abcdef0123456789abcdef",
  apiToken: "workers-ai-token-with-enough-entropy",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workers AI input validation", () => {
  it("normalizes credentials without weakening their format", () => {
    expect(normalizeWorkersAiCredentials(
      ` ${CREDENTIALS.accountId.toUpperCase()} `,
      ` ${CREDENTIALS.apiToken} `,
    )).toEqual(CREDENTIALS);
    expect(() => normalizeWorkersAiCredentials("short", CREDENTIALS.apiToken)).toThrow(
      "32 hexadecimal",
    );
    expect(() => normalizeWorkersAiCredentials(CREDENTIALS.accountId, "short")).toThrow(
      "invalid format",
    );
  });

  it("accepts only canonical Workers AI model identifiers", () => {
    expect(normalizeWorkersAiModelId(" @cf/meta/llama-3.3 ")).toBe("@cf/meta/llama-3.3");
    expect(() => normalizeWorkersAiModelId("https://example.com/model")).toThrow(
      "Invalid Workers AI model identifier",
    );
  });
});

describe("Workers AI REST adapter", () => {
  it("normalizes the catalog and filters unsupported or inactive entries", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain(`/accounts/${CREDENTIALS.accountId}/ai/models/search`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CREDENTIALS.apiToken}`);
      expect(init?.redirect).toBe("manual");
      return Response.json({
        success: true,
        result: [
          { id: "@cf/meta/chat", name: "Chat", task: { name: "text-generation" } },
          { id: "@cf/baai/bge", name: "BGE", task: "text-embeddings" },
          { id: "@cf/meta/old", name: "Old", task: "text-generation", deprecated: true },
          { id: "@cf/meta/beta", name: "Beta", task: "text-generation", beta: true },
          { id: "not-a-model", name: "Invalid", task: "text-generation" },
        ],
        result_info: { total_pages: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new WorkersAiApi(CREDENTIALS).listModels("text-generation")).resolves.toEqual([
      { id: "@cf/meta/chat", name: "Chat", task: "text-generation" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reads model input property names and encodes inference model paths", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ai/models/schema")) {
        expect(url.searchParams.get("model")).toBe("@cf/openai/whisper");
        expect(init?.redirect).toBe("manual");
        return Response.json({
          success: true,
          result: { input: { type: "object", properties: { audio: {}, language: {} } } },
        });
      }
      expect(url.pathname.endsWith("/ai/run/%40cf/openai/whisper")).toBe(true);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      return Response.json({ success: true, result: { text: "hello" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new WorkersAiApi(CREDENTIALS);

    await expect(api.getInputFields("@cf/openai/whisper")).resolves.toEqual(
      new Set(["audio", "language"]),
    );
    await expect(api.runJson("@cf/openai/whisper", { audio: [1, 2] })).resolves.toEqual({
      text: "hello",
    });
  });

  it("surfaces Cloudflare auth failures as typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    }, { status: 403 })));

    const error = await new WorkersAiApi(CREDENTIALS).listModels().catch(reason => reason);
    expect(error).toBeInstanceOf(WorkersAiApiError);
    expect(error).toMatchObject({ status: 403, codes: [10000], isAuthError: true });
  });
});
