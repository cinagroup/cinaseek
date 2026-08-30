import type {
  WorkersAiCredentials,
  WorkersAiModelInfo,
  WorkersAiTask,
} from "@gadgets/workshop-shared/workers-ai-gatekeeper";

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const MODEL_ID_PATTERN = /^@[a-z0-9._-]+(?:\/[a-z0-9._-]+){2,}$/i;
const MAX_TOKEN_LENGTH = 2048;
const MAX_CATALOG_PAGES = 10;
const CATALOG_PAGE_SIZE = 100;

const TASK_ALIASES = new Map<string, WorkersAiTask>([
  ["textgeneration", "text-generation"],
  ["textembeddings", "text-embeddings"],
  ["embeddings", "text-embeddings"],
  ["texttoimage", "text-to-image"],
  ["automaticspeechrecognition", "automatic-speech-recognition"],
  ["speechrecognition", "automatic-speech-recognition"],
  ["texttospeech", "text-to-speech"],
  ["textclassification", "text-classification"],
]);

type JsonRecord = Record<string, unknown>;

type CloudflareEnvelope = {
  result?: unknown;
  success?: unknown;
  errors?: unknown;
  result_info?: unknown;
};

/** Provider failure with a status that callers can use for credential-expiry handling. */
export class WorkersAiApiError extends Error {
  /** HTTP status returned by Cloudflare. */
  readonly status: number;

  /** Provider numeric error codes, without caller-controlled message text. */
  readonly codes: number[];

  constructor(message: string, status: number, codes: number[] = []) {
    super(message);
    this.name = "WorkersAiApiError";
    this.status = status;
    this.codes = codes;
  }

  /** Whether Cloudflare rejected or no longer accepts the connected credentials. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function tagStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      result.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const label = firstString(record, ["name", "id", "label", "value"]);
    if (label) result.push(label);
  }
  return result;
}

function normalizeTaskCandidate(value: unknown): WorkersAiTask | undefined {
  let candidate: string | undefined;
  if (typeof value === "string") candidate = value;
  else {
    const record = asRecord(value);
    if (record) candidate = firstString(record, ["id", "name", "task", "label"]);
  }
  if (!candidate) return undefined;
  return TASK_ALIASES.get(candidate.toLowerCase().replace(/[^a-z]/g, ""));
}

/** Normalize and validate one user-supplied Cloudflare Workers AI credential pair. */
export function normalizeWorkersAiCredentials(
  accountId: string,
  apiToken: string,
): WorkersAiCredentials {
  const normalizedAccountId = accountId.trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalizedAccountId)) {
    throw new Error("Cloudflare Account ID must be 32 hexadecimal characters.");
  }

  const normalizedToken = apiToken.trim();
  const hasControlCharacter = [...normalizedToken].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (normalizedToken.length < 20 || normalizedToken.length > MAX_TOKEN_LENGTH ||
      hasControlCharacter) {
    throw new Error("Cloudflare API Token has an invalid format.");
  }

  return { accountId: normalizedAccountId, apiToken: normalizedToken };
}

/** Validate one exact model identifier obtained from Cloudflare's account-scoped catalog. */
export function normalizeWorkersAiModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (normalized.length > 200 || !MODEL_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid Workers AI model identifier.");
  }
  return normalized;
}

function modelFromUnknown(value: unknown): WorkersAiModelInfo | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = firstString(record, ["id", "model_id", "model", "name"]);
  if (!id) return null;
  let normalizedId: string;
  try {
    normalizedId = normalizeWorkersAiModelId(id);
  } catch {
    return null;
  }

  const task = normalizeTaskCandidate(record.task) ??
    normalizeTaskCandidate(record.task_name) ??
    normalizeTaskCandidate(record.task_id);
  if (!task) return null;

  const tags = [
    ...tagStrings(record.tags),
    ...tagStrings(record.properties),
    ...tagStrings(record.capabilities),
  ].map(tag => tag.toLowerCase());
  const deprecated = record.deprecated === true || tags.some(tag => tag.includes("deprecated"));
  const experimental = record.experimental === true || record.beta === true ||
    tags.some(tag => tag.includes("experimental") || tag === "beta");

  return {
    id: normalizedId,
    name: firstString(record, ["display_name", "name", "title"]) ?? normalizedId,
    task,
    description: firstString(record, ["description", "summary"]),
    deprecated: deprecated || undefined,
    experimental: experimental || undefined,
  };
}

function providerErrors(value: unknown): { codes: number[]; message?: string } {
  if (!Array.isArray(value)) return { codes: [] };
  const codes: number[] = [];
  let message: string | undefined;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    if (typeof record.code === "number") codes.push(record.code);
    if (!message && typeof record.message === "string") message = record.message;
  }
  return { codes, message };
}

async function parseEnvelope(response: Response): Promise<CloudflareEnvelope> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new WorkersAiApiError(
      response.ok ? "Cloudflare returned an invalid JSON response." :
        `Cloudflare Workers AI request failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  const envelope = asRecord(parsed);
  if (!envelope) {
    throw new WorkersAiApiError("Cloudflare returned an invalid API response.", response.status);
  }
  const errors = providerErrors(envelope.errors);
  if (!response.ok || envelope.success === false) {
    throw new WorkersAiApiError(
      errors.message ?? `Cloudflare Workers AI request failed with HTTP ${response.status}.`,
      response.status,
      errors.codes,
    );
  }
  return envelope;
}

/** Parse a successful Workers AI JSON response and return its normalized result payload. */
export async function unwrapWorkersAiJsonResponse(response: Response): Promise<unknown> {
  return (await parseEnvelope(response)).result;
}

function extractCatalogResult(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record) return [];
  for (const key of ["models", "items", "data", "result"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function totalPages(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const pages = record.total_pages ?? record.totalPages;
  return typeof pages === "number" && Number.isInteger(pages) && pages > 0 ? pages : undefined;
}

function modelPath(modelId: string): string {
  return normalizeWorkersAiModelId(modelId).split("/").map(encodeURIComponent).join("/");
}

/** Minimal Workers AI REST client that keeps credentials private to the gatekeeper. */
export class WorkersAiApi {
  readonly #credentials: WorkersAiCredentials;

  constructor(credentials: WorkersAiCredentials) {
    this.#credentials = normalizeWorkersAiCredentials(
      credentials.accountId,
      credentials.apiToken,
    );
  }

  #headers(additional?: HeadersInit): Headers {
    const headers = new Headers(additional);
    headers.set("authorization", `Bearer ${this.#credentials.apiToken}`);
    return headers;
  }

  /** List active supported models visible to this account. */
  async listModels(task?: WorkersAiTask): Promise<WorkersAiModelInfo[]> {
    const result = new Map<string, WorkersAiModelInfo>();
    for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
      const url = new URL(
        `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${this.#credentials.accountId}/ai/models/search`,
      );
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(CATALOG_PAGE_SIZE));
      url.searchParams.set("hide_experimental", "false");
      url.searchParams.set("include_deprecated", "true");
      const response = await fetch(url, {
        headers: this.#headers({ accept: "application/json" }),
        redirect: "error",
      });
      const envelope = await parseEnvelope(response);
      const pageItems = extractCatalogResult(envelope.result);
      for (const item of pageItems) {
        const model = modelFromUnknown(item);
        if (!model || model.deprecated || model.experimental || (task && model.task !== task)) {
          continue;
        }
        result.set(model.id, model);
      }
      const pages = totalPages(envelope.result_info);
      if (pageItems.length < CATALOG_PAGE_SIZE || (pages !== undefined && page >= pages)) break;
    }
    return [...result.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** Return the declared input property names for one model. */
  async getInputFields(modelId: string): Promise<Set<string>> {
    const url = new URL(
      `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${this.#credentials.accountId}/ai/models/schema`,
    );
    url.searchParams.set("model", normalizeWorkersAiModelId(modelId));
    const response = await fetch(url, {
      headers: this.#headers({ accept: "application/json" }),
      redirect: "error",
    });
    const envelope = await parseEnvelope(response);
    const result = asRecord(envelope.result);
    const input = asRecord(result?.input);
    const properties = asRecord(input?.properties);
    return new Set(properties ? Object.keys(properties) : []);
  }

  /** Execute a model and return the untouched provider response. */
  async run(modelId: string, body: BodyInit, contentType: string): Promise<Response> {
    const response = await fetch(
      `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${this.#credentials.accountId}/ai/run/` +
        modelPath(modelId),
      {
        method: "POST",
        headers: this.#headers({ "content-type": contentType }),
        body,
        redirect: "error",
      },
    );
    if (response.ok) return response;

    const clone = response.clone();
    const contentTypeHeader = response.headers.get("content-type") ?? "";
    if (contentTypeHeader.includes("json")) {
      await parseEnvelope(clone);
    }
    throw new WorkersAiApiError(
      `Cloudflare Workers AI request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  /** Execute a JSON model and unwrap Cloudflare's standard result envelope. */
  async runJson(modelId: string, input: JsonRecord): Promise<unknown> {
    const response = await this.run(modelId, JSON.stringify(input), "application/json");
    return unwrapWorkersAiJsonResponse(response);
  }
}
