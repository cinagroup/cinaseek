import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_DAYS = 14;
const MAXIMUM_DAYS = 31;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PROVIDER_ROWS = 20_000;
const TOLERANCE_RATIO = 0.15;

/** One closed UTC day's deployment-attributed cost. */
export interface DailyAttributedCost {
  /** UTC date in YYYY-MM-DD format. */
  day: string;
  /** Cost attributed from authoritative platform metrics and product-event drivers. */
  attributedCostUsd: number;
}

/** Strict input contract for the fourteen-day invoice reconciliation. */
export interface BillingAttributionInput {
  /** Version of the attribution input contract. */
  schemaVersion: 1;
  /** Billing currency; the production acceptance route currently requires USD. */
  currency: "USD";
  /** At least fourteen consecutive, closed UTC days. */
  days: DailyAttributedCost[];
}

/** One sanitized daily invoice comparison. */
export interface DailyBillingReconciliation {
  /** Closed UTC date. */
  day: string;
  /** Locally attributed deployment cost. */
  attributedCostUsd: number;
  /** Sum of Cloudflare V1 `BilledCost` usage rows for the day. */
  billedCostUsd?: number;
  /** Absolute difference divided by billed cost; omitted when billed cost is zero. */
  deviationRatio?: number;
  /** Whether this day has complete provider evidence and is within the fixed 15% gate. */
  withinTolerance: boolean;
}

/** Privacy-preserving fourteen-day billing reconciliation report. */
export interface BillingV1ReconciliationReport {
  /** Version of the reconciliation report contract. */
  schemaVersion: 1;
  /** Fixed acceptance threshold; callers cannot weaken it. */
  toleranceRatio: 0.15;
  /** Sanitized daily comparisons. */
  days: DailyBillingReconciliation[];
  /** Totals across all requested days. */
  totals: {
    attributedCostUsd: number;
    billedCostUsd: number;
    deviationRatio?: number;
  };
  /** Number of account usage rows included without retaining their identifiers or descriptions. */
  providerRowsConsidered: number;
  /** True only when every requested day has evidence and is within 15%. */
  valid: boolean;
  /** Bounded failure classes without provider-authored text or account metadata. */
  issues: string[];
}

interface BillingV1Row {
  accountId: string;
  billedCost: number;
  currency: string;
  category: string;
  periodStart: string;
  periodEnd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseDay(value: string): number {
  if (!DAY.test(value)) throw new Error("attribution contains an invalid UTC day");
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("attribution contains an invalid UTC day");
  }
  return timestamp;
}

function parseAttribution(value: unknown, now: Date): BillingAttributionInput {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.currency !== "USD" ||
      !Array.isArray(value.days) || value.days.length < MINIMUM_DAYS ||
      value.days.length > MAXIMUM_DAYS || !Number.isFinite(now.valueOf())) {
    throw new Error("attribution must contain 14-31 consecutive closed USD days");
  }
  const currentDay = now.toISOString().slice(0, 10);
  const days = value.days.map(item => {
    if (!isRecord(item) || typeof item.day !== "string" ||
        typeof item.attributedCostUsd !== "number" ||
        !Number.isFinite(item.attributedCostUsd) || item.attributedCostUsd < 0 ||
        item.attributedCostUsd > 1_000_000_000) {
      throw new Error("attribution contains an invalid daily cost");
    }
    return { day: item.day, attributedCostUsd: rounded(item.attributedCostUsd) };
  });
  const timestamps = days.map(item => parseDay(item.day));
  for (let index = 0; index < timestamps.length; index++) {
    if (days[index].day >= currentDay) throw new Error("attribution days must be closed in UTC");
    if (index > 0 && timestamps[index] !== timestamps[index - 1] + DAY_MS) {
      throw new Error("attribution days must be consecutive and sorted");
    }
  }
  return { schemaVersion: 1, currency: "USD", days };
}

function parseProviderRow(value: unknown): BillingV1Row {
  if (!isRecord(value) || typeof value.BillingAccountId !== "string" ||
      typeof value.BilledCost !== "number" || !Number.isFinite(value.BilledCost) ||
      typeof value.BillingCurrency !== "string" || typeof value.ChargeCategory !== "string" ||
      typeof value.ChargePeriodStart !== "string" ||
      typeof value.ChargePeriodEnd !== "string") {
    throw new Error("Cloudflare Billing V1 returned an invalid usage row");
  }
  return {
    accountId: value.BillingAccountId,
    billedCost: value.BilledCost,
    currency: value.BillingCurrency,
    category: value.ChargeCategory,
    periodStart: value.ChargePeriodStart,
    periodEnd: value.ChargePeriodEnd,
  };
}

function providerCodes(value: unknown): number[] {
  if (!isRecord(value) || !Array.isArray(value.errors)) return [];
  return value.errors.flatMap(error =>
    isRecord(error) && typeof error.code === "number" && Number.isFinite(error.code)
      ? [error.code]
      : []
  ).slice(0, 10);
}

function providerRows(value: unknown): BillingV1Row[] {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.result) ||
      value.result.length > MAX_PROVIDER_ROWS) {
    throw new Error("Cloudflare Billing V1 returned an invalid response envelope");
  }
  return value.result.map(parseProviderRow);
}

/** Reconcile validated attribution against raw Cloudflare Billing V1 rows. */
export function reconcileBillingV1(
  attributionValue: unknown,
  providerValue: unknown,
  accountId: string,
  now: Date = new Date(),
): BillingV1ReconciliationReport {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("invalid Cloudflare account ID");
  const attribution = parseAttribution(attributionValue, now);
  const rows = providerRows(providerValue);
  const requestedDays = new Set(attribution.days.map(item => item.day));
  const billedByDay = new Map<string, number>();
  const observedDays = new Set<string>();
  const issues: string[] = [];
  let considered = 0;
  for (const row of rows) {
    if (row.accountId !== accountId || row.currency !== attribution.currency) {
      throw new Error("Cloudflare Billing V1 row does not match the requested account and currency");
    }
    if (row.category !== "Usage") continue;
    const day = row.periodStart.slice(0, 10);
    if (!requestedDays.has(day)) continue;
    const start = Date.parse(row.periodStart);
    const end = Date.parse(row.periodEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== DAY_MS ||
        new Date(start).toISOString() !== `${day}T00:00:00.000Z`) {
      issues.push(`non_daily_usage_period:${day}`);
      continue;
    }
    observedDays.add(day);
    billedByDay.set(day, (billedByDay.get(day) ?? 0) + row.billedCost);
    considered++;
  }

  const days: DailyBillingReconciliation[] = attribution.days.map(item => {
    if (!observedDays.has(item.day)) {
      issues.push(`missing_billing_day:${item.day}`);
      return { ...item, withinTolerance: false };
    }
    const billedCostUsd = rounded(billedByDay.get(item.day) ?? 0);
    if (billedCostUsd === 0) {
      const withinTolerance = item.attributedCostUsd === 0;
      if (!withinTolerance) issues.push(`zero_billed_cost_mismatch:${item.day}`);
      return { ...item, billedCostUsd, withinTolerance };
    }
    const deviationRatio = rounded(
      Math.abs(item.attributedCostUsd - billedCostUsd) / Math.abs(billedCostUsd),
    );
    const withinTolerance = deviationRatio <= TOLERANCE_RATIO;
    if (!withinTolerance) issues.push(`daily_deviation_above_15_percent:${item.day}`);
    return { ...item, billedCostUsd, deviationRatio, withinTolerance };
  });
  const attributedTotal = rounded(days.reduce((total, item) => total + item.attributedCostUsd, 0));
  const billedTotal = rounded(days.reduce((total, item) => total + (item.billedCostUsd ?? 0), 0));
  const totalDeviation = billedTotal === 0
    ? undefined
    : rounded(Math.abs(attributedTotal - billedTotal) / Math.abs(billedTotal));
  const uniqueIssues = [...new Set(issues)];
  return {
    schemaVersion: 1,
    toleranceRatio: TOLERANCE_RATIO,
    days,
    totals: {
      attributedCostUsd: attributedTotal,
      billedCostUsd: billedTotal,
      ...(totalDeviation === undefined ? {} : { deviationRatio: totalDeviation }),
    },
    providerRowsConsidered: considered,
    valid: uniqueIssues.length === 0 && days.every(item => item.withinTolerance),
    issues: uniqueIssues,
  };
}

/** Fetch the current-period V1 billable usage with a read-only token and reconcile it locally. */
export async function collectAndReconcileBillingV1(
  attributionValue: unknown,
  accountId: string,
  apiToken: string,
  options: { fetch?: typeof fetch; now?: Date } = {},
): Promise<BillingV1ReconciliationReport> {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("invalid Cloudflare account ID");
  if (!apiToken.trim()) throw new Error("Cloudflare Billing Read token is required");
  const request = options.fetch ?? fetch;
  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/billable-usage`,
    { method: "GET", headers: { authorization: `Bearer ${apiToken.trim()}` } },
  );
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Cloudflare Billing V1 response exceeds 5 MiB");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("Cloudflare Billing V1 response exceeds 5 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare Billing V1 failed with status ${response.status} and invalid JSON`);
  }
  if (!response.ok || !isRecord(value) || value.success !== true) {
    throw new Error(
      `Cloudflare Billing V1 failed with status ${response.status} and codes ${JSON.stringify(providerCodes(value))}`,
    );
  }
  return reconcileBillingV1(attributionValue, value, accountId, options.now);
}

async function attributionFile(path: string): Promise<unknown> {
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INPUT_BYTES) {
    throw new Error(`unsafe attribution input: ${basename(resolved)}`);
  }
  try {
    return JSON.parse(await readFile(resolved, "utf8")) as unknown;
  } catch {
    throw new Error("attribution input is not valid JSON");
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv: string[]): { attribution?: string; help: boolean } {
  let attribution: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--attribution") attribution = argv[++index];
    else if (argument === "--help") help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return { attribution, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error("Usage: pnpm audit:billing:v1 -- --attribution <daily-costs.json>");
    return;
  }
  if (!args.attribution) throw new Error("--attribution <daily-costs.json> is required");
  const report = await collectAndReconcileBillingV1(
    await attributionFile(args.attribution),
    requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    requiredEnvironment("CINASEEK_AI_GATEWAY_TOKEN"),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      `Billing V1 reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
