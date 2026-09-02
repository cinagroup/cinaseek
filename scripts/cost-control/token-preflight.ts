import {
  CloudflareAlertMetricsClient,
  type CloudflareAlertMetricsConfig,
} from "./cloudflare-alert-metrics.ts";

/** Cloudflare permission represented by one production capability probe. */
export type CostControlCapability =
  | "accountAnalytics"
  | "aiGateway"
  | "durableObjects"
  | "workersObservability";

/** Sanitized result for one permission probe. */
export interface CostControlCapabilityResult {
  /** Whether the production endpoint accepted and validated the request. */
  ok: boolean;
  /** HTTP-like status retained from bounded collector errors. */
  status?: number;
  /** Numeric provider codes; provider messages are deliberately discarded. */
  codes: readonly number[];
}

/** Complete, non-secret preflight report. */
export interface CostControlTokenPreflight {
  /** True only when every production capability is usable. */
  ok: boolean;
  /** Probe results keyed by the required capability. */
  capabilities: Record<CostControlCapability, CostControlCapabilityResult>;
}

type ProbeClient = Pick<
  CloudflareAlertMetricsClient,
  "queryAiGatewayCost" |
  "queryLogMetrics" |
  "queryOverseerHourlyCost" |
  "queryOverseerObjectIds"
>;

function failure(error: unknown): CostControlCapabilityResult {
  if (typeof error !== "object" || error === null) return { ok: false, codes: [] };
  const status = "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  const codes = "codes" in error && Array.isArray(error.codes) &&
      error.codes.every(code => typeof code === "number")
    ? error.codes
    : [];
  return { ok: false, ...(status === undefined ? {} : { status }), codes };
}

async function probe(operation: () => Promise<unknown>): Promise<CostControlCapabilityResult> {
  try {
    await operation();
    return { ok: true, codes: [] };
  } catch (error) {
    return failure(error);
  }
}

/** Verify all Cloudflare capabilities required by the scheduled monitor without exposing data. */
export async function verifyCostControlToken(
  client: ProbeClient,
  now: Date = new Date(),
): Promise<CostControlTokenPreflight> {
  if (!Number.isFinite(now.valueOf())) throw new Error("invalid preflight timestamp");
  const to = new Date(now);
  const from = new Date(to.valueOf() - 5 * 60 * 1000);
  const entries = await Promise.all([
    probe(() => client.queryOverseerHourlyCost(from, to))
      .then(result => ["accountAnalytics", result] as const),
    probe(() => client.queryAiGatewayCost(from, to))
      .then(result => ["aiGateway", result] as const),
    probe(() => client.queryOverseerObjectIds())
      .then(result => ["durableObjects", result] as const),
    probe(() => client.queryLogMetrics(
      from,
      to,
      ["cost.metric.workspace.session.started"],
    )).then(result => ["workersObservability", result] as const),
  ]);
  const capabilities = Object.fromEntries(entries) as
    Record<CostControlCapability, CostControlCapabilityResult>;
  return {
    ok: Object.values(capabilities).every(result => result.ok),
    capabilities,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const config: CloudflareAlertMetricsConfig = {
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requiredEnvironment("CINASEEK_AI_GATEWAY_TOKEN"),
    backendService: requiredEnvironment("BACKEND_SERVICE"),
    overseerNamespaceId: requiredEnvironment("OVERSEER_NAMESPACE_ID"),
    aiGatewayId: requiredEnvironment("AI_GATEWAY_ID"),
  };
  const result = await verifyCostControlToken(new CloudflareAlertMetricsClient(config));
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
