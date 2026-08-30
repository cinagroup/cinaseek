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
  it("normalizes the task catalog without hiding provider-listed models", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain(`/accounts/${CREDENTIALS.accountId}/ai/models/search`);
      expect(url.searchParams.has("task")).toBe(false);
      expect(url.searchParams.get("per_page")).toBe("50");
      expect(url.searchParams.has("include_deprecated")).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CREDENTIALS.apiToken}`);
      expect(init?.redirect).toBe("manual");
      return Response.json({
        success: true,
        result: [
          { id: "@cf/meta/chat", name: "Chat", task: { name: "text-generation" } },
          { id: "@cf/meta/old", name: "Old", task: "text-generation", deprecated: true },
          { id: "@cf/meta/beta", name: "Beta", task: "text-generation", beta: true },
          { id: "@cf/meta/taskless", name: "Taskless" },
          { id: "not-a-model", name: "Invalid", task: "text-generation" },
          { id: "internal-id", name: "@cf/meta/name-as-id", task: "text-generation" },
        ],
        result_info: { total_pages: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new WorkersAiApi(CREDENTIALS).listModels("text-generation")).resolves.toEqual([
      {
        id: "@cf/meta/name-as-id",
        name: "@cf/meta/name-as-id",
        task: "text-generation",
        description: undefined,
        deprecated: undefined,
        experimental: undefined,
      },
      {
        id: "@cf/meta/beta",
        name: "Beta",
        task: "text-generation",
        description: undefined,
        deprecated: undefined,
        experimental: true,
      },
      {
        id: "@cf/meta/chat",
        name: "Chat",
        task: "text-generation",
        description: undefined,
        deprecated: undefined,
        experimental: undefined,
      },
      {
        id: "@cf/meta/old",
        name: "Old",
        task: "text-generation",
        description: undefined,
        deprecated: true,
        experimental: undefined,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the provider task display name when its task id returns no models", async () => {
    const queries: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const task = new URL(String(input)).searchParams.get("task");
      queries.push(task);
      return Response.json({
        success: true,
        result: task === "Text Generation"
          ? [{ id: "@cf/meta/chat", name: "Chat", task: { name: task } }]
          : [],
        result_info: { total_pages: 1 },
      });
    }));

    await expect(new WorkersAiApi(CREDENTIALS).listModels("text-generation")).resolves.toEqual([
      { id: "@cf/meta/chat", name: "Chat", task: "text-generation" },
    ]);
    expect(queries).toEqual([null, "text-generation", "Text Generation"]);
  });

  it("builds the complete catalog from an unfiltered provider response", async () => {
    const taskEntries = [
      ["automatic-speech-recognition", "Automatic Speech Recognition"],
      ["text-classification", "Text Classification"],
      ["text-embeddings", "Text Embeddings"],
      ["text-generation", "Text Generation"],
      ["text-to-image", "Text-to-Image"],
      ["text-to-speech", "Text-to-Speech"],
    ] as const;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.has("task")).toBe(false);
      return Response.json({
        success: true,
        result: taskEntries.map(([id, name]) => ({
          id: `@cf/test/${id}`,
          name,
          task: { id, name },
        })),
        result_info: { total_pages: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await new WorkersAiApi(CREDENTIALS).listModels();
    expect(models).toHaveLength(6);
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
