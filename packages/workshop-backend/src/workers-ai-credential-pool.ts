import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.workers-ai-credential-pool");

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_TOKEN_LENGTH = 2048;
const AUTH_FAILURE_COOLDOWN_MS = 15 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const UPSTREAM_FAILURE_COOLDOWN_MS = 15_000;
const NETWORK_FAILURE_COOLDOWN_MS = 30_000;

type CredentialRow = {
  owner_id: string;
  account_id: string;
  api_token: string;
  last_used_at: number;
  cooldown_until: number;
  failure_count: number;
};

/** Aggregate shared-pool health information safe to return to authenticated clients. */
export type WorkersAiPoolStatus = {
  /** Number of contributed credentials, including credentials in a temporary cooldown. */
  total: number;

  /** Number of credentials eligible for the next request. */
  available: number;
};

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
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
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
    const credential = this.ctx.storage.sql.exec<CredentialRow>(`
      SELECT owner_id, account_id, api_token, last_used_at, cooldown_until, failure_count
      FROM credentials
      WHERE cooldown_until <= ?
      ORDER BY last_used_at ASC, owner_id ASC
      LIMIT 1
    `, now).toArray()[0];
    if (!credential) return unavailableResponse();

    this.ctx.storage.sql.exec(
        "UPDATE credentials SET last_used_at = ?, updated_at = ? WHERE owner_id = ?",
        now, now, credential.owner_id);

    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    const accept = request.headers.get("accept");
    const sessionAffinity = request.headers.get("x-session-affinity");
    if (contentType) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    if (sessionAffinity) headers.set("x-session-affinity", sessionAffinity);
    headers.set("authorization", `Bearer ${credential.api_token}`);

    let response: Response;
    try {
      response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${credential.account_id}/ai/v1/` +
          "chat/completions",
          {
            method: "POST",
            headers,
            body: request.body,
            redirect: "error",
            signal: request.signal,
          });
    } catch (error) {
      const cooldownUntil = Date.now() + NETWORK_FAILURE_COOLDOWN_MS;
      this.ctx.storage.sql.exec(`
        UPDATE credentials
        SET cooldown_until = ?, failure_count = failure_count + 1, updated_at = ?
        WHERE owner_id = ?
      `, cooldownUntil, Date.now(), credential.owner_id);
      logger.warn("shared Workers AI request failed before response", {
        event: "workers_ai.pool.request.failed", modelId: this.ctx.id.name ?? "unknown",
        durationMs: NETWORK_FAILURE_COOLDOWN_MS,
        // Network errors can include the upstream URL (and therefore the contributor's account
        // ID). Record only the error class so credentials and account identifiers stay out of logs.
        statusText: error instanceof Error ? error.name : "UnknownError",
      });
      throw new Error("Shared Workers AI upstream request failed.");
    }

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

    return response;
  }
}
