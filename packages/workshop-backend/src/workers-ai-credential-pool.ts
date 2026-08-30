import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  WorkersAiSpeechOptions,
  WorkersAiSpeechTiming,
  WorkersAiSpeechTranscription,
} from "@gadgets/workshop-shared/workers-ai-gatekeeper";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.workers-ai-credential-pool");

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
// Workerd supports manual redirects, which also prevents a shared bearer token from being sent to
// any redirect target returned by the Cloudflare API.
const CLOUDFLARE_API_REDIRECT = "manual" as const;
const MAX_TOKEN_LENGTH = 2048;
const AUTH_FAILURE_COOLDOWN_MS = 15 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const UPSTREAM_FAILURE_COOLDOWN_MS = 15_000;
const NETWORK_FAILURE_COOLDOWN_MS = 30_000;
const MAX_SPEECH_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_SPEECH_DURATION_SECONDS = 60;

/** ASR models whose credentials may be contributed to the shared voice-input pool. */
export const SHAREABLE_WORKERS_AI_SPEECH_MODEL_IDS = [
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/openai/whisper",
] as const;

/** Maximum audio time one shared credential serves per UTC day. */
export const SHARED_SPEECH_CREDENTIAL_DAILY_SECONDS = 2 * 60 * 60;

const SHAREABLE_SPEECH_MODELS = new Set<string>(SHAREABLE_WORKERS_AI_SPEECH_MODEL_IDS);

type CredentialRow = {
  owner_id: string;
  account_id: string;
  api_token: string;
  last_used_at: number;
  cooldown_until: number;
  failure_count: number;
  daily_audio_day: string;
  daily_audio_seconds: number;
};

/** Aggregate shared-pool health information safe to return to authenticated clients. */
export type WorkersAiPoolStatus = {
  /** Number of contributed credentials, including credentials in a temporary cooldown. */
  total: number;

  /** Number of credentials eligible for the next request. */
  available: number;
};

/** Whether a model may receive explicitly shared Workers AI ASR credentials. */
export function isShareableWorkersAiSpeechModelId(modelId: string): boolean {
  return SHAREABLE_SPEECH_MODELS.has(modelId);
}

function normalizeAccountId(accountId: string): string {
  const normalized = accountId.trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new Error("Cloudflare Account ID must be 32 hexadecimal characters.");
  }
  return normalized;
}

function normalizeApiToken(apiToken: string): string {
  const normalized = apiToken.trim();
  const hasControlCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (normalized.length < 20 || normalized.length > MAX_TOKEN_LENGTH || hasControlCharacter) {
    throw new Error("Cloudflare API Token has an invalid format.");
  }
  return normalized;
}

/** Validates and normalizes a user-supplied Workers AI credential pair. */
export function normalizeWorkersAiCredentials(
    accountId: string, apiToken: string): { accountId: string; apiToken: string } {
  return {
    accountId: normalizeAccountId(accountId),
    apiToken: normalizeApiToken(apiToken),
  };
}

function normalizeSpeechDuration(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      durationSeconds > MAX_SPEECH_DURATION_SECONDS) {
    throw new Error(`Speech duration must be between 0 and ${MAX_SPEECH_DURATION_SECONDS} seconds.`);
  }
  return Math.max(1, Math.ceil(durationSeconds));
}

function normalizeSpeechLanguage(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  const normalized = language.trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) {
    throw new Error("Speech language must be a valid language code.");
  }
  return normalized;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timingEntries(value: unknown): WorkersAiSpeechTiming[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: WorkersAiSpeechTiming[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const text = typeof record.word === "string" ? record.word :
      typeof record.text === "string" ? record.text : undefined;
    const start = finiteNumber(record.start) ?? finiteNumber(record.start_seconds);
    const end = finiteNumber(record.end) ?? finiteNumber(record.end_seconds);
    if (text !== undefined && start !== undefined && end !== undefined) {
      result.push({ text, startSeconds: start, endSeconds: end });
    }
  }
  return result.length > 0 ? result : undefined;
}

async function parseSpeechResponse(
  response: Response,
  modelId: string,
  includeTimings: boolean,
): Promise<WorkersAiSpeechTranscription> {
  const envelope = asRecord(await response.json());
  const result = asRecord(envelope?.result);
  const info = asRecord(result?.transcription_info) ?? asRecord(result?.results) ?? result;
  if (envelope?.success !== true || !info || typeof info.text !== "string") {
    throw new Error("Shared Workers AI returned an invalid transcription.");
  }
  return {
    text: info.text,
    language: typeof info.language === "string" ? info.language : undefined,
    durationSeconds: finiteNumber(info.duration) ?? finiteNumber(info.duration_seconds),
    modelId,
    words: includeTimings
      ? timingEntries(info.words) ?? timingEntries(info.segments) ??
        timingEntries(result?.words) ?? timingEntries(result?.segments)
      : undefined,
  };
}

function cooldownForStatus(status: number): number {
  if (status === 401 || status === 403) return AUTH_FAILURE_COOLDOWN_MS;
  if (status === 429) return RATE_LIMIT_COOLDOWN_MS;
  if (status >= 500) return UPSTREAM_FAILURE_COOLDOWN_MS;
  return 0;
}

function unavailableResponse(): Response {
  return Response.json({
    error: {
      type: "service_unavailable",
      message: "No shared Workers AI credential is currently available.",
    },
  }, { status: 503 });
}

/**
 * One model-specific Workers AI credential pool. Instances are sharded by model id through
 * `getByName(modelId)`, avoiding a global inference bottleneck while keeping routing strongly
 * consistent for each model.
 */
@validateRpc()
export class WorkersAiCredentialPool extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        owner_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        api_token TEXT NOT NULL,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        daily_audio_day TEXT NOT NULL DEFAULT '',
        daily_audio_seconds INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
    const columns = new Set(this.ctx.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(credentials)").toArray().map(column => column.name));
    if (!columns.has("daily_audio_day")) {
      this.ctx.storage.sql.exec(
          "ALTER TABLE credentials ADD COLUMN daily_audio_day TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("daily_audio_seconds")) {
      this.ctx.storage.sql.exec(
          "ALTER TABLE credentials ADD COLUMN daily_audio_seconds INTEGER NOT NULL DEFAULT 0");
    }
    this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS credentials_route " +
        "ON credentials(cooldown_until, last_used_at, owner_id)");
  }

  /** Adds or replaces the calling user's credential and clears its failure cooldown. */
  upsert(ownerId: string, accountId: string, apiToken: string): void {
    if (!ownerId) throw new Error("Credential owner is required.");
    const normalized = normalizeWorkersAiCredentials(accountId, apiToken);
    const now = Date.now();
    this.ctx.storage.sql.exec(`
      INSERT INTO credentials (
        owner_id, account_id, api_token, last_used_at, cooldown_until,
        failure_count, added_at, updated_at
      ) VALUES (?, ?, ?, 0, 0, 0, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        account_id = excluded.account_id,
        api_token = excluded.api_token,
        cooldown_until = 0,
        failure_count = 0,
        updated_at = excluded.updated_at
    `, ownerId, normalized.accountId, normalized.apiToken, now, now);
  }

  /** Removes a user's contribution without returning its secret. Idempotent. */
  remove(ownerId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM credentials WHERE owner_id = ?", ownerId);
  }

  /** Returns aggregate pool health without owner identifiers or secrets. */
  status(): WorkersAiPoolStatus {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ total: number; available: number }>(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN cooldown_until <= ? THEN 1 ELSE 0 END), 0) AS available
      FROM credentials
    `, now).one();
    return { total: row.total, available: row.available };
  }

  /** Returns pool health after excluding credentials that exhausted today's shared ASR quota. */
  speechStatus(): WorkersAiPoolStatus {
    const now = Date.now();
    const day = utcDay(now);
    const row = this.ctx.storage.sql.exec<{ total: number; available: number }>(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE
          WHEN cooldown_until <= ? AND
            (daily_audio_day <> ? OR daily_audio_seconds < ?)
          THEN 1 ELSE 0 END), 0) AS available
      FROM credentials
    `, now, day, SHARED_SPEECH_CREDENTIAL_DAILY_SECONDS).one();
    return { total: row.total, available: row.available };
  }

  #selectCredential(now: number, speechSeconds?: number): CredentialRow | undefined {
    const columns = "owner_id, account_id, api_token, last_used_at, cooldown_until, " +
      "failure_count, daily_audio_day, daily_audio_seconds";
    if (speechSeconds === undefined) {
      return this.ctx.storage.sql.exec<CredentialRow>(`
        SELECT ${columns}
        FROM credentials
        WHERE cooldown_until <= ?
        ORDER BY last_used_at ASC, owner_id ASC
        LIMIT 1
      `, now).toArray()[0];
    }
    const day = utcDay(now);
    return this.ctx.storage.sql.exec<CredentialRow>(`
      SELECT ${columns}
      FROM credentials
      WHERE cooldown_until <= ? AND
        (daily_audio_day <> ? OR daily_audio_seconds + ? <= ?)
      ORDER BY last_used_at ASC, owner_id ASC
      LIMIT 1
    `, now, day, speechSeconds, SHARED_SPEECH_CREDENTIAL_DAILY_SECONDS).toArray()[0];
  }

  #markCredentialUsed(credential: CredentialRow, now: number, speechSeconds?: number): void {
    if (speechSeconds === undefined) {
      this.ctx.storage.sql.exec(
          "UPDATE credentials SET last_used_at = ?, updated_at = ? WHERE owner_id = ?",
          now, now, credential.owner_id);
      return;
    }
    const day = utcDay(now);
    this.ctx.storage.sql.exec(`
      UPDATE credentials SET
        last_used_at = ?,
        daily_audio_seconds = CASE
          WHEN daily_audio_day = ? THEN daily_audio_seconds + ? ELSE ? END,
        daily_audio_day = ?,
        updated_at = ?
      WHERE owner_id = ?
    `, now, day, speechSeconds, speechSeconds, day, now, credential.owner_id);
  }

  #settleSpeechCharge(
    credential: CredentialRow,
    day: string,
    reservedSeconds: number,
    reportedDurationSeconds: number | undefined,
  ): void {
    if (reportedDurationSeconds === undefined || !Number.isFinite(reportedDurationSeconds) ||
        reportedDurationSeconds <= 0 || reportedDurationSeconds > MAX_SPEECH_DURATION_SECONDS) {
      return;
    }
    const actualSeconds = Math.max(1, Math.ceil(reportedDurationSeconds));
    this.ctx.storage.sql.exec(`
      UPDATE credentials SET
        daily_audio_seconds = MAX(0, daily_audio_seconds - ? + ?),
        updated_at = ?
      WHERE owner_id = ? AND daily_audio_day = ?
    `, reservedSeconds, actualSeconds, Date.now(), credential.owner_id, day);
  }

  #noteResponse(credential: CredentialRow, response: Response): void {
    const cooldown = cooldownForStatus(response.status);
    if (cooldown > 0) {
      this.ctx.storage.sql.exec(`
        UPDATE credentials
        SET cooldown_until = ?, failure_count = failure_count + 1, updated_at = ?
        WHERE owner_id = ?
      `, Date.now() + cooldown, Date.now(), credential.owner_id);
      logger.warn("shared Workers AI credential entered cooldown", {
        event: "workers_ai.pool.credential.cooldown", modelId: this.ctx.id.name ?? "unknown",
        status: response.status, durationMs: cooldown,
      });
    } else if (response.ok && credential.failure_count > 0) {
      this.ctx.storage.sql.exec(`
        UPDATE credentials
        SET cooldown_until = 0, failure_count = 0, updated_at = ?
        WHERE owner_id = ?
      `, Date.now(), credential.owner_id);
    }
  }

  async #fetch(
    credential: CredentialRow,
    url: string,
    init: RequestInit,
    operation: "request" | "speech",
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          authorization: `Bearer ${credential.api_token}`,
        },
        redirect: CLOUDFLARE_API_REDIRECT,
      });
    } catch (error) {
      const cooldownUntil = Date.now() + NETWORK_FAILURE_COOLDOWN_MS;
      this.ctx.storage.sql.exec(`
        UPDATE credentials
        SET cooldown_until = ?, failure_count = failure_count + 1, updated_at = ?
        WHERE owner_id = ?
      `, cooldownUntil, Date.now(), credential.owner_id);
      logger.warn("shared Workers AI request failed before response", {
        event: `workers_ai.pool.${operation}.failed`, modelId: this.ctx.id.name ?? "unknown",
        durationMs: NETWORK_FAILURE_COOLDOWN_MS,
        // Network errors can include the upstream URL (and therefore the contributor's account
        // ID). Record only the error class so credentials and account identifiers stay out of logs.
        statusText: error instanceof Error ? error.name : "UnknownError",
      });
      // oxlint-disable-next-line eslint/preserve-caught-error -- The upstream error may contain the contributor's account ID.
      throw new Error("Shared Workers AI upstream request failed.");
    }
    this.#noteResponse(credential, response);
    return response;
  }

  /**
   * Routes one OpenAI-compatible Workers AI request through the least-recently-used available
   * credential. Authentication, rate-limit and upstream failures cool that credential for later
   * requests; response bodies remain streamed and are never buffered for retries.
   */
  async run(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const now = Date.now();
    const credential = this.#selectCredential(now);
    if (!credential) return unavailableResponse();
    this.#markCredentialUsed(credential, now);

    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    const accept = request.headers.get("accept");
    const sessionAffinity = request.headers.get("x-session-affinity");
    if (contentType) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    if (sessionAffinity) headers.set("x-session-affinity", sessionAffinity);
    return this.#fetch(
      credential,
      `https://api.cloudflare.com/client/v4/accounts/${credential.account_id}/ai/v1/` +
        "chat/completions",
      { method: "POST", headers, body: request.body, signal: request.signal },
      "request",
    );
  }

  /** Transcribes one bounded clip through the least-recently-used healthy shared credential. */
  async transcribe(
    modelId: string,
    audio: Blob,
    durationSeconds: number,
    options: WorkersAiSpeechOptions = {},
  ): Promise<WorkersAiSpeechTranscription> {
    if (!isShareableWorkersAiSpeechModelId(modelId) || this.ctx.id.name !== modelId) {
      throw new Error("This model is not shareable through the Workers AI speech pool.");
    }
    if (audio.size <= 0 || audio.size > MAX_SPEECH_AUDIO_BYTES) {
      throw new Error(`Audio must be between 1 byte and ${MAX_SPEECH_AUDIO_BYTES} bytes.`);
    }
    normalizeSpeechDuration(durationSeconds);
    const language = normalizeSpeechLanguage(options.language);
    const now = Date.now();
    // Reserve the maximum clip length before yielding to fetch. The client-reported duration is
    // untrusted; a successful provider duration refunds the unused portion after inference.
    const reservedSeconds = MAX_SPEECH_DURATION_SECONDS;
    const reservationDay = utcDay(now);
    const credential = this.#selectCredential(now, reservedSeconds);
    if (!credential) throw new Error("No shared Workers AI speech credential is available.");
    this.#markCredentialUsed(credential, now, reservedSeconds);

    const bytes = new Uint8Array(await audio.arrayBuffer());
    const payload: JsonRecord = { audio: [...bytes] };
    if (modelId === SHAREABLE_WORKERS_AI_SPEECH_MODEL_IDS[0]) {
      if (language) payload.language = language;
      payload.vad_filter = true;
    }
    const modelPath = modelId.split("/").map(encodeURIComponent).join("/");
    const response = await this.#fetch(
      credential,
      `https://api.cloudflare.com/client/v4/accounts/${credential.account_id}/ai/run/${modelPath}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      },
      "speech",
    );
    if (!response.ok) {
      throw new Error(`Shared Workers AI speech request failed with HTTP ${response.status}.`);
    }
    const transcript = await parseSpeechResponse(response, modelId, options.wordTimestamps === true);
    this.#settleSpeechCharge(
      credential,
      reservationDay,
      reservedSeconds,
      transcript.durationSeconds,
    );
    return transcript;
  }
}
