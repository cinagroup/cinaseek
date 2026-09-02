import {
  evaluateCostControlAlerts,
  initialCostControlAlertState,
  type CostControlAlertId,
  type CostControlAlertState,
  type CostControlEvaluation,
} from "./alert-evaluator.ts";
import {
  CloudflareAlertMetricsClient,
  type CloudflareAlertMetricsConfig,
} from "./cloudflare-alert-metrics.ts";
import {
  collectCostControlSample,
  type CostControlCollection,
  type CostControlCollectorState,
} from "./cost-control-collector.ts";
import {
  reconcileWorkspaceBlobs,
  type WorkspaceBlobBucket,
  type WorkspaceBlobMetadataService,
} from "./workspace-blob-reconciler.ts";

const STATE_KEY = "cost-control-state-v1";
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_ACTIVE_RESERVATIONS = 2_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

interface KvNamespace {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

/** Environment bindings for the standalone production cost-control monitor. */
export interface CostControlWorkerEnv {
  /** KV namespace storing the alert edge state and reservation ledger. */
  ALERT_STATE: KvNamespace;
  /** Existing R2 bucket containing immutable workspace attachment bodies. */
  WORKSPACE_BLOBS?: WorkspaceBlobBucket;
  /** Backend named service entrypoint for authoritative attachment metadata matching. */
  BACKEND_RECONCILER?: WorkspaceBlobMetadataService;
  /** Cloudflare account tag. */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Read-only Cloudflare API token stored as a Worker secret. */
  CLOUDFLARE_API_TOKEN: string;
  /** Production Workshop Backend service name. */
  BACKEND_SERVICE: string;
  /** `OverseerDurableObject` namespace ID. */
  OVERSEER_NAMESPACE_ID: string;
  /** Production AI Gateway ID. */
  AI_GATEWAY_ID: string;
  /** Maximum supported agent run duration in milliseconds. */
  AGENT_MAX_DURATION_MS: string;
  /** Optional HTTPS incident webhook. */
  ALERT_WEBHOOK_URL?: string;
  /** Optional bearer token for the incident webhook, stored as a Worker secret. */
  ALERT_WEBHOOK_TOKEN?: string;
  /** Stable, non-secret deployment label included with alert transitions. */
  DEPLOYMENT_NAME?: string;
}

interface PersistedCostControlState {
  version: 1;
  alerts: CostControlAlertState;
  collector: CostControlCollectorState;
}

/** Dependency overrides used by deterministic Worker tests. */
export interface CostControlWorkerDependencies {
  /** Prebuilt metrics client. */
  client?: CloudflareAlertMetricsClient;
  /** Collector override. */
  collect?: typeof collectCostControlSample;
  /** Fetch implementation for the optional notification webhook. */
  fetch?: typeof fetch;
  /** Structured log sink. */
  log?: (record: Record<string, unknown>) => void;
}

const ALERT_IDS = new Set<CostControlAlertId>([
  "do_cost_per_active_workspace",
  "workspace_session_completion",
  "realtime_security",
  "realtime_handshake_failure_rate",
  "workspace_blob_integrity",
  "dynamic_worker_growth",
  "usage_limit_or_stale_reservation",
  "unit_cost_growth",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseAlertState(value: unknown): CostControlAlertState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.lastStatuses) ||
      !Number.isSafeInteger(value.unitCostConsecutiveBreachHours) ||
      (value.unitCostConsecutiveBreachHours as number) < 0 ||
      (value.lastUnitCostWindowId !== undefined && !isIsoTimestamp(value.lastUnitCostWindowId))) {
    throw new Error("persisted alert state is invalid");
  }
  const lastStatuses: CostControlAlertState["lastStatuses"] = {};
  for (const [key, status] of Object.entries(value.lastStatuses)) {
    if (!ALERT_IDS.has(key as CostControlAlertId) || (status !== "ok" && status !== "firing")) {
      throw new Error("persisted alert status is invalid");
    }
    lastStatuses[key as CostControlAlertId] = status;
  }
  return {
    version: 1,
    lastStatuses,
    unitCostConsecutiveBreachHours: value.unitCostConsecutiveBreachHours as number,
    ...(value.lastUnitCostWindowId === undefined
      ? {}
      : { lastUnitCostWindowId: value.lastUnitCostWindowId as string }),
  };
}

function parseCollectorState(value: unknown): CostControlCollectorState {
  if (!isRecord(value) || !isRecord(value.activeReservations) ||
      (value.lastReservationScanAt !== undefined && !isIsoTimestamp(value.lastReservationScanAt))) {
    throw new Error("persisted collector state is invalid");
  }
  const entries = Object.entries(value.activeReservations);
  if (entries.length > MAX_ACTIVE_RESERVATIONS) {
    throw new Error("persisted reservation ledger exceeded its safe bound");
  }
  const activeReservations: Record<string, number> = {};
  for (const [executionId, timestamp] of entries) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(executionId) || typeof timestamp !== "number" || !Number.isFinite(timestamp) ||
      timestamp < 0) {
      throw new Error("persisted reservation ledger entry is invalid");
    }
    activeReservations[executionId] = timestamp;
  }
  return {
    activeReservations,
    ...(value.lastReservationScanAt === undefined
      ? {}
      : { lastReservationScanAt: value.lastReservationScanAt as string }),
  };
}

function parsePersistedState(value: unknown): PersistedCostControlState {
  if (value === null) {
    return {
      version: STATE_VERSION,
      alerts: initialCostControlAlertState(),
      collector: { activeReservations: {} },
    };
  }
  if (!isRecord(value) || value.version !== STATE_VERSION) {
    throw new Error("persisted cost-control state version is invalid");
  }
  return {
    version: STATE_VERSION,
    alerts: parseAlertState(value.alerts),
    collector: parseCollectorState(value.collector),
  };
}

function metricsConfig(env: CostControlWorkerEnv): CloudflareAlertMetricsConfig {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    backendService: env.BACKEND_SERVICE,
    overseerNamespaceId: env.OVERSEER_NAMESPACE_ID,
    aiGatewayId: env.AI_GATEWAY_ID,
  };
}

function agentMaxDurationMs(env: CostControlWorkerEnv): number {
  const value = Number(env.AGENT_MAX_DURATION_MS);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 3_600_000) {
    throw new Error("AGENT_MAX_DURATION_MS must be between 60000 and 3600000");
  }
  return value;
}

function webhookUrl(env: CostControlWorkerEnv): URL | undefined {
  if (!env.ALERT_WEBHOOK_URL) return undefined;
  const url = new URL(env.ALERT_WEBHOOK_URL);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("ALERT_WEBHOOK_URL must be an HTTPS URL without embedded credentials");
  }
  return url;
}

function transitionPayload(
  env: CostControlWorkerEnv,
  evaluation: CostControlEvaluation,
  observedAt: string,
) {
  return evaluation.transitions.map(transition => {
    const result = evaluation.results.find(candidate => candidate.id === transition.id);
    return {
      schemaVersion: 1,
      deployment: env.DEPLOYMENT_NAME ?? "cinaseek",
      observedAt,
      alertId: transition.id,
      transition: transition.type,
      reason: transition.reason,
      observed: result?.observed ?? {},
    };
  });
}

async function notifyWebhook(
  env: CostControlWorkerEnv,
  payloads: ReturnType<typeof transitionPayload>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = webhookUrl(env);
  if (!url || payloads.length === 0) return;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.ALERT_WEBHOOK_TOKEN
        ? { Authorization: `Bearer ${env.ALERT_WEBHOOK_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ alerts: payloads }),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
}

function serializeState(state: PersistedCostControlState): string {
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
    throw new Error("cost-control state exceeded its size limit");
  }
  return serialized;
}

/** Run one scheduled collection, evaluation, notification, and atomic-looking KV state commit. */
export async function runCostControlMonitor(
  env: CostControlWorkerEnv,
  scheduledTime: number,
  dependencies: CostControlWorkerDependencies = {},
): Promise<CostControlEvaluation> {
  if (!Number.isFinite(scheduledTime)) throw new Error("scheduledTime is invalid");
  const log = dependencies.log ?? (record => console.log(JSON.stringify(record)));
  const previous = parsePersistedState(await env.ALERT_STATE.get<unknown>(STATE_KEY, "json"));
  const client = dependencies.client ?? new CloudflareAlertMetricsClient(metricsConfig(env));
  const collect = dependencies.collect ?? collectCostControlSample;
  if (Boolean(env.WORKSPACE_BLOBS) !== Boolean(env.BACKEND_RECONCILER)) {
    throw new Error("WORKSPACE_BLOBS and BACKEND_RECONCILER must be configured together");
  }
  const collection: CostControlCollection = await collect(
    client,
    new Date(scheduledTime),
    previous.collector,
    {
      agentMaxDurationMs: agentMaxDurationMs(env),
      ...(env.WORKSPACE_BLOBS && env.BACKEND_RECONCILER
        ? {
            queryWorkspaceOrphanBytes: async () =>
              (await reconcileWorkspaceBlobs(
                client,
                env.WORKSPACE_BLOBS!,
                env.BACKEND_RECONCILER!,
              )).orphanBytes,
          }
        : {}),
    },
  );
  for (const failure of collection.failures) {
    log({ event: "cost.alert.source.failed", ...failure });
  }
  const evaluation = evaluateCostControlAlerts(collection.sample, previous.alerts);
  for (const result of evaluation.results) {
    log({
      event: "cost.alert.evaluated",
      alertId: result.id,
      status: result.status,
      reason: result.reason,
      observed: result.observed,
      observedAt: collection.sample.observedAt,
    });
  }
  const payloads = transitionPayload(env, evaluation, collection.sample.observedAt);
  for (const payload of payloads) {
    log({ event: `cost.alert.${payload.transition}`, ...payload });
  }
  await notifyWebhook(env, payloads, dependencies.fetch ?? fetch);
  await env.ALERT_STATE.put(STATE_KEY, serializeState({
    version: STATE_VERSION,
    alerts: evaluation.nextState,
    collector: collection.nextState,
  }));
  return evaluation;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found.", { status: 404 });
  },

  async scheduled(
    controller: { scheduledTime: number },
    env: CostControlWorkerEnv,
  ): Promise<void> {
    await runCostControlMonitor(env, controller.scheduledTime);
  },
};
