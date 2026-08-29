const BINDING_BASE_URL = "https://workers-ai-binding.invalid/v1";

function openAiError(message: string, status: number): Response {
  return Response.json({ error: { message, type: "invalid_request_error" } }, { status });
}

/**
 * Adapt the OpenAI-compatible fetch calls emitted by pi to Cloudflare's in-process Workers AI
 * binding. `returnRawResponse` preserves Cloudflare's native streaming response and headers, so
 * pi can consume the SSE body exactly as it would over HTTPS without any account API token.
 */
export function createWorkersAiBindingFetch(
    ai: Pick<Ai, "run">, expectedModelId: string): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method !== "POST") {
      return openAiError("Workers AI binding transport only accepts POST requests.", 405);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return openAiError("Workers AI binding request body must be valid JSON.", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return openAiError("Workers AI binding request body must be a JSON object.", 400);
    }

    const payload = { ...body } as Record<string, unknown>;
    if (payload.model !== expectedModelId) {
      return openAiError("Workers AI binding request used an unexpected model.", 400);
    }
    delete payload.model;

    const response = await ai.run(expectedModelId, payload, {
      returnRawResponse: true,
      signal: request.signal,
    });
    if (!(response instanceof Response)) {
      throw new Error("Workers AI binding did not return a raw Response.");
    }
    return response;
  };
}

/** Base URL used only to satisfy the OpenAI SDK before fetch is redirected to the AI binding. */
export const WORKERS_AI_BINDING_BASE_URL = BINDING_BASE_URL;
