const API_BASE = "https://api.cloudflare.com/client/v4";
const GRAPHQL_URL = `${API_BASE}/graphql`;
const OBSERVABILITY_DATASETS = ["cloudflare-workers"];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_AI_GATEWAY_PAGES = 20;
const AI_GATEWAY_PAGE_SIZE = 50;
const GRAPHQL_GROUP_LIMIT = 10_000;
const DURABLE_OBJECT_PAGE_SIZE = 10_000;
const MAX_DURABLE_OBJECT_PAGES = 20;

/** Configuration for the least-privilege Cloudflare metrics collector. */
export interface CloudflareAlertMetricsConfig {
  /** Cloudflare account tag. */
  accountId: string;
  /** Read-only API token; never included in errors or returned samples. */
  apiToken: string;
  /** Production Workshop Backend service name in Workers Observability. */
  backendService: string;
  /** Durable Object namespace ID for `OverseerDurableObject`. */
  overseerNamespaceId: string;
  /** AI Gateway whose estimated request cost is attributed to the deployment. */
  aiGatewayId: string;
}

/** One grouped Workers Observability calculation row. */
export interface LogMetricGroup {
  /** Structured logger event name. */
  event: string;
  /** Optional bounded outcome/operation dimension. */
  operation?: string;
  /** Number of matching structured log events. */
  count: number;
  /** Sum of `durationMs` for matching events that carry it. */
  durationMs: number;
}

/** Optional grouping dimensions for a Workers Observability calculation. */
export interface LogMetricQueryOptions {
  /** Split each event by its bounded `operation` value. */
  groupByOperation?: boolean;
  /** Query and merge `durationMs` sums separately so missing duration fields cannot erase counts. */
  includeDuration?: boolean;
}

/** One authoritative Durable Object hourly cost sample. */
export interface DurableObjectHourlyCost {
  /** Cloudflare's UTC hour bucket. */
  hour: string;
  /** Sum of billed Durable Object duration in GB-s. */
  durationGbSeconds: number;
  /** Distinct active Overseer objects in the hour. */
  activeWorkspaces: number;
  /** GB-s divided by distinct active Overseer object count. */
  gbSecondsPerActiveWorkspace: number;
}

/** Correlation-safe reservation event used to find stale active reservations. */
export interface ReservationMetricEvent {
  /** Reservation UUID emitted as the structured `executionId`. */
  executionId: string;
  /** Lifecycle edge. */
  type: "created" | "settled";
  /** Provider event timestamp in milliseconds. */
  timestamp: number;
}

/** Secret-free classification for failures raised before an HTTP response exists. */
export type CloudflareAlertMetricsFailureKind =
  | "timeout"
  | "invalid_header"
  | "same_zone_fetch"
  | "cloudflare_address"
  | "request_context"
  | "unsupported_runtime"
  | "access_restricted"
  | "request_shape"
  | "illegal_receiver"
  | "network"
  | "type_error"
  | "unknown";

/** Bounded Cloudflare API failure with no provider-authored message or token content. */
export class CloudflareAlertMetricsError extends Error {
  /** HTTP-like failure status. */
  readonly status: number;

  /** Numeric provider codes, when present. */
  readonly codes: readonly number[];

  /** Allowlisted runtime failure class when no provider response was received. */
  readonly failureKind?: CloudflareAlertMetricsFailureKind;

  constructor(
    status: number,
    message: string,
    codes: readonly number[] = [],
    failureKind?: CloudflareAlertMetricsFailureKind,
  ) {
    super(message);
    this.status = status;
    this.codes = codes;
    this.failureKind = failureKind;
  }
}

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function classifyFetchFailure(error: unknown): CloudflareAlertMetricsFailureKind {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message.toLowerCase();
  if (/\b1042\b|same[- ]zone/.test(message)) return "same_zone_fetch";
  if (/\b1024\b|cloudflare-owned/.test(message)) return "cloudflare_address";
  if (/request context|different request/.test(message)) return "request_context";
  if (/header|byte string/.test(message)) return "invalid_header";
  if (/not implemented|not supported|is not a function/.test(message)) return "unsupported_runtime";
  if (/access control|cannot access|not allowed/.test(message)) return "access_restricted";
  if (/expected pattern|invalid url|fetch api cannot load/.test(message)) return "request_shape";
  if (/illegal invocation|incorrect this|invalid receiver/.test(message)) return "illegal_receiver";
  if (/network|fetch failed|connection|dns/.test(message)) return "network";
  return error.name === "TypeError" ? "type_error" : "unknown";
}

function assertIsoRange(from: Date, to: Date): void {
  if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || from >= to) {
    throw new Error("metrics timeframe must have valid dates with from before to");
  }
}

function assertIdentifier(value: string, name: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`invalid ${name}`);
}

function eventFilter(eventNames: readonly string[]): object {
  return {
    kind: "group",
    filterCombination: "or",
    filters: eventNames.map(value => ({
      kind: "filter",
      key: "event",
      operation: "eq",
      type: "string",
      value,
    })),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CloudflareAlertMetricsError(502, "Cloudflare metrics response exceeded the size limit.");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CloudflareAlertMetricsError(502, "Cloudflare metrics response exceeded the size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CloudflareAlertMetricsError(502, "Cloudflare metrics response was not valid JSON.");
  }
}

function providerCodes(value: unknown): number[] {
  if (!isRecord(value) || !Array.isArray(value.errors)) return [];
  return value.errors.flatMap(error =>
    isRecord(error) && isFiniteNumber(error.code) ? [error.code] : []);
}

function parseApiEnvelope(value: unknown, status: number): Record<string, unknown> {
  if (!isRecord(value) || value.success !== true || !("result" in value)) {
    throw new CloudflareAlertMetricsError(
      status || 502,
      "Cloudflare metrics API request failed.",
      providerCodes(value),
    );
  }
  if (!isRecord(value.result)) {
    throw new CloudflareAlertMetricsError(502, "Cloudflare metrics API returned an invalid result.");
  }
  return value.result;
}

function calculationGroups(value: unknown): Array<{ key: string; value: string | number | boolean }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CloudflareAlertMetricsError(502, "Invalid calculation groups.");
  return value.map(group => {
    if (!isRecord(group) || typeof group.key !== "string" ||
        !(typeof group.value === "string" || typeof group.value === "number" ||
          typeof group.value === "boolean")) {
      throw new CloudflareAlertMetricsError(502, "Invalid calculation group.");
    }
    return { key: group.key, value: group.value };
  });
}

function parseLogMetrics(value: unknown): LogMetricGroup[] {
  if (!Array.isArray(value)) {
    throw new CloudflareAlertMetricsError(502, "Invalid observability calculations.");
  }
  const merged = new Map<string, LogMetricGroup>();
  for (const calculation of value) {
    if (!isRecord(calculation) || typeof calculation.alias !== "string" ||
        !Array.isArray(calculation.aggregates)) {
      throw new CloudflareAlertMetricsError(502, "Invalid observability calculation.");
    }
    for (const aggregate of calculation.aggregates) {
      if (!isRecord(aggregate) || !isFiniteNumber(aggregate.value)) {
        throw new CloudflareAlertMetricsError(502, "Invalid observability aggregate.");
      }
      const groups = calculationGroups(aggregate.groups);
      const event = groups.find(group => group.key === "event")?.value;
      const operation = groups.find(group => group.key === "operation")?.value;
      if (typeof event !== "string" ||
          (operation !== undefined && typeof operation !== "string")) {
        throw new CloudflareAlertMetricsError(502, "Observability aggregate omitted its event group.");
      }
      const key = `${event}\u0000${operation ?? ""}`;
      const row = merged.get(key) ?? { event, operation, count: 0, durationMs: 0 };
      if (calculation.alias === "count") row.count = aggregate.value;
      else if (calculation.alias === "durationMs") row.durationMs = aggregate.value;
      else throw new CloudflareAlertMetricsError(502, "Unexpected observability calculation alias.");
      merged.set(key, row);
    }
  }
  return [...merged.values()];
}

/** Count reservations whose creation has no settlement at or after the supplied cutoff. */
export function countStaleReservations(
  events: ReservationMetricEvent[],
  cutoffTimestamp: number,
): number {
  if (!Number.isFinite(cutoffTimestamp)) throw new Error("invalid reservation cutoff");
  const active = new Map<string, number>();
  for (const event of events.toSorted((left, right) => left.timestamp - right.timestamp)) {
    if (!Number.isFinite(event.timestamp) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(event.executionId)) {
      throw new Error("invalid reservation metric event");
    }
    if (event.type === "created") active.set(event.executionId, event.timestamp);
    else active.delete(event.executionId);
  }
  return [...active.values()].filter(timestamp => timestamp < cutoffTimestamp).length;
}

/** Strict, bounded Cloudflare collector used by the scheduled alert monitor. */
export class CloudflareAlertMetricsClient {
  readonly #config: CloudflareAlertMetricsConfig;
  readonly #fetch: FetchLike;

  constructor(config: CloudflareAlertMetricsConfig, fetchImpl: FetchLike = fetch) {
    assertIdentifier(config.accountId, "account id", /^[0-9a-f]{32}$/i);
    assertIdentifier(config.overseerNamespaceId, "Overseer namespace id", /^[0-9a-f]{32}$/i);
    assertIdentifier(config.backendService, "backend service", /^[a-z0-9][a-z0-9-]{0,62}$/);
    assertIdentifier(config.aiGatewayId, "AI Gateway id", /^[a-z0-9][a-z0-9_-]{0,63}$/);
    const apiToken = config.apiToken.trim();
    if (!apiToken) throw new Error("Cloudflare API token is required");
    this.#config = { ...config, apiToken };
    this.#fetch = fetchImpl;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    let didTimeout = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Response>((_resolve, reject) => {
      timeout = setTimeout(() => {
        didTimeout = true;
        reject(new Error("Cloudflare metrics request timeout"));
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      const fetchImpl = this.#fetch;
      const request = fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#config.apiToken}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      return await Promise.race([request, timeoutPromise]);
    } catch (error) {
      if (didTimeout) {
        throw new CloudflareAlertMetricsError(
          504,
          "Cloudflare metrics request timed out.",
          [],
          "timeout",
        );
      }
      throw new CloudflareAlertMetricsError(
        502,
        "Could not reach the Cloudflare metrics API.",
        [],
        classifyFetchFailure(error),
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async #api(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.#request(url, init);
    const body = await readBoundedJson(response);
    if (!response.ok) {
      throw new CloudflareAlertMetricsError(
        response.status,
        "Cloudflare metrics API request failed.",
        providerCodes(body),
      );
    }
    return parseApiEnvelope(body, response.status);
  }

  async #graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#request(GRAPHQL_URL, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    const body = await readBoundedJson(response);
    if (!response.ok || !isRecord(body) || Array.isArray(body.errors) || !isRecord(body.data)) {
      throw new CloudflareAlertMetricsError(
        response.status || 502,
        "Cloudflare GraphQL metrics request failed.",
        providerCodes(body),
      );
    }
    return body.data;
  }

  /** Query grouped counts and optional duration sums for an allowlisted event set. */
  async queryLogMetrics(
    from: Date,
    to: Date,
    eventNames: string[],
    options: LogMetricQueryOptions = {},
  ): Promise<LogMetricGroup[]> {
    assertIsoRange(from, to);
    if (eventNames.length === 0 || eventNames.length > 50 ||
        eventNames.some(name => !/^[a-z][a-z0-9._-]{0,127}$/.test(name))) {
      throw new Error("invalid observability event allowlist");
    }
    const url =
      `${API_BASE}/accounts/${this.#config.accountId}/workers/observability/telemetry/query`;
    const query = (queryId: string, calculations: object[]) => this.#api(url, {
        method: "POST",
        body: JSON.stringify({
          queryId,
          view: "calculations",
          dry: true,
          timeframe: { from: from.valueOf(), to: to.valueOf() },
          limit: 2000,
          chart: false,
          ignoreSeries: true,
          parameters: {
            datasets: OBSERVABILITY_DATASETS,
            filterCombination: "and",
            filters: [
              {
                kind: "filter",
                key: "$metadata.service",
                operation: "eq",
                type: "string",
                value: this.#config.backendService,
              },
              eventFilter(eventNames),
            ],
            calculations,
            groupBys: [
              { value: "event", type: "string" },
              ...(options.groupByOperation
                ? [{ value: "operation", type: "string" }]
                : []),
            ],
            limit: 2000,
          },
        }),
      });
    const [countResult, durationResult] = await Promise.all([
      query("cinaseek-cost-control-metric-counts", [
        { operator: "count", alias: "count" },
      ]),
      options.includeDuration
        ? query("cinaseek-cost-control-metric-durations", [{
            operator: "sum",
            key: "durationMs",
            keyType: "number",
            alias: "durationMs",
          }])
        : Promise.resolve(undefined),
    ]);
    const countCalculations = countResult.calculations;
    const durationCalculations = durationResult?.calculations;
    if (!Array.isArray(countCalculations) ||
        (durationCalculations !== undefined && !Array.isArray(durationCalculations))) {
      throw new CloudflareAlertMetricsError(502, "Invalid observability calculations.");
    }
    return parseLogMetrics([
      ...countCalculations,
      ...(durationCalculations ?? []),
    ]);
  }

  /** Read reservation create/settle edges for stale-reservation correlation. */
  async queryReservationEvents(from: Date, to: Date): Promise<ReservationMetricEvent[]> {
    assertIsoRange(from, to);
    const result = await this.#api(
      `${API_BASE}/accounts/${this.#config.accountId}/workers/observability/telemetry/query`,
      {
        method: "POST",
        body: JSON.stringify({
          queryId: "cinaseek-cost-control-reservations",
          view: "events",
          dry: true,
          timeframe: { from: from.valueOf(), to: to.valueOf() },
          limit: 2000,
          parameters: {
            datasets: OBSERVABILITY_DATASETS,
            filterCombination: "and",
            filters: [
              {
                kind: "filter",
                key: "$metadata.service",
                operation: "eq",
                type: "string",
                value: this.#config.backendService,
              },
              eventFilter([
                "usage.reservation.created",
                "usage.reservation.settled",
              ]),
            ],
            limit: 2000,
          },
        }),
      },
    );
    if (!isRecord(result.events) || !Array.isArray(result.events.events)) {
      throw new CloudflareAlertMetricsError(502, "Invalid reservation event response.");
    }
    if (isFiniteNumber(result.events.count) && result.events.count > 2000) {
      throw new CloudflareAlertMetricsError(507, "Reservation event query exceeded its safe bound.");
    }
    return result.events.events.map(value => {
      if (!isRecord(value) || !isFiniteNumber(value.timestamp) || !isRecord(value.source) ||
          typeof value.source.event !== "string" || typeof value.source.executionId !== "string") {
        throw new CloudflareAlertMetricsError(502, "Invalid reservation event.");
      }
      const type = value.source.event === "usage.reservation.created"
        ? "created"
        : value.source.event === "usage.reservation.settled"
          ? "settled"
          : undefined;
      if (!type) throw new CloudflareAlertMetricsError(502, "Unexpected reservation event.");
      return { executionId: value.source.executionId, timestamp: value.timestamp, type };
    });
  }

  /** Read authoritative Overseer DO duration and active-object counts by UTC hour. */
  async queryOverseerHourlyCost(from: Date, to: Date): Promise<DurableObjectHourlyCost[]> {
    assertIsoRange(from, to);
    const data = await this.#graphql(
      `query CostControlDoHourly($accountTag: string!, $namespaceId: string!, $from: Time!, $to: Time!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            durableObjectsPeriodicGroups(limit: ${GRAPHQL_GROUP_LIMIT}, filter: {
              namespaceId: $namespaceId, datetime_geq: $from, datetime_lt: $to
            }) {
              dimensions { datetimeHour objectId }
              sum { duration }
            }
          }
        }
      }`,
      {
        accountTag: this.#config.accountId,
        namespaceId: this.#config.overseerNamespaceId,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    );
    const viewer = data.viewer;
    if (!isRecord(viewer) || !Array.isArray(viewer.accounts) || viewer.accounts.length !== 1 ||
        !isRecord(viewer.accounts[0]) ||
        !Array.isArray(viewer.accounts[0].durableObjectsPeriodicGroups)) {
      throw new CloudflareAlertMetricsError(502, "Invalid Durable Object metrics response.");
    }
    const rows = viewer.accounts[0].durableObjectsPeriodicGroups;
    if (rows.length >= GRAPHQL_GROUP_LIMIT) {
      throw new CloudflareAlertMetricsError(
        507,
        "Durable Object metrics reached the safe group bound.",
      );
    }
    const hours = new Map<string, { duration: number; objects: Set<string> }>();
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.dimensions) || !isRecord(row.sum) ||
          typeof row.dimensions.datetimeHour !== "string" ||
          typeof row.dimensions.objectId !== "string" ||
          !isFiniteNumber(row.sum.duration) || row.sum.duration < 0) {
        throw new CloudflareAlertMetricsError(502, "Invalid Durable Object metric row.");
      }
      const hour = row.dimensions.datetimeHour;
      const aggregate = hours.get(hour) ?? { duration: 0, objects: new Set<string>() };
      aggregate.duration += row.sum.duration;
      aggregate.objects.add(row.dimensions.objectId);
      hours.set(hour, aggregate);
    }
    return [...hours.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(
      ([hour, aggregate]) => ({
        hour,
        durationGbSeconds: aggregate.duration,
        activeWorkspaces: aggregate.objects.size,
        gbSecondsPerActiveWorkspace: aggregate.duration / aggregate.objects.size,
      }),
    );
  }

  /** Query the account's billable distinct Dynamic Worker count for one date range. */
  async queryDistinctDynamicWorkers(fromDate: string, toDate: string): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) ||
        fromDate > toDate) {
      throw new Error("invalid Dynamic Worker date range");
    }
    const data = await this.#graphql(
      `query CostControlDynamicWorkers(
        $accountTag: string!,
        $filter: AccountWorkersInvocationsByOwnerAndScriptGroupsFilter_InputObject
      ) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsByOwnerAndScriptGroups(limit: 2, filter: $filter) {
              uniq { distinctDynamicWorkerCount }
            }
          }
        }
      }`,
      {
        accountTag: this.#config.accountId,
        filter: { date_geq: fromDate, date_leq: toDate },
      },
    );
    const viewer = data.viewer;
    if (!isRecord(viewer) || !Array.isArray(viewer.accounts) || viewer.accounts.length !== 1 ||
        !isRecord(viewer.accounts[0]) ||
        !Array.isArray(viewer.accounts[0].workersInvocationsByOwnerAndScriptGroups)) {
      throw new CloudflareAlertMetricsError(502, "Invalid Dynamic Worker metrics response.");
    }
    const rows = viewer.accounts[0].workersInvocationsByOwnerAndScriptGroups;
    if (rows.length === 0) return 0;
    if (rows.length !== 1) {
      throw new CloudflareAlertMetricsError(
        502,
        "Dynamic Worker metrics returned ambiguous grouped rows.",
      );
    }
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.uniq) ||
          !isFiniteNumber(row.uniq.distinctDynamicWorkerCount) ||
          row.uniq.distinctDynamicWorkerCount < 0) {
        throw new CloudflareAlertMetricsError(502, "Invalid Dynamic Worker metric row.");
      }
      return row.uniq.distinctDynamicWorkerCount;
    }
    return 0;
  }

  /** Sum estimated AI Gateway request cost over a bounded, fully paginated time range. */
  async queryAiGatewayCost(from: Date, to: Date): Promise<{ cost: number; requests: number }> {
    assertIsoRange(from, to);
    let cost = 0;
    let requests = 0;
    for (let page = 1; page <= MAX_AI_GATEWAY_PAGES; page++) {
      const search = new URLSearchParams({
        start_date: from.toISOString(),
        end_date: to.toISOString(),
        per_page: String(AI_GATEWAY_PAGE_SIZE),
        page: String(page),
      });
      const response = await this.#request(
        `${API_BASE}/accounts/${this.#config.accountId}/ai-gateway/gateways/` +
          `${encodeURIComponent(this.#config.aiGatewayId)}/logs?${search}`,
        { method: "GET", headers: { Accept: "application/json" } },
      );
      const body = await readBoundedJson(response);
      if (!response.ok || !isRecord(body) || body.success !== true || !Array.isArray(body.result)) {
        throw new CloudflareAlertMetricsError(
          response.status || 502,
          "Cloudflare AI Gateway cost request failed.",
          providerCodes(body),
        );
      }
      for (const log of body.result) {
        if (!isRecord(log) || (log.cost !== undefined && !isFiniteNumber(log.cost))) {
          throw new CloudflareAlertMetricsError(502, "Invalid AI Gateway cost log.");
        }
        cost += log.cost ?? 0;
        requests++;
      }
      const info = body.result_info;
      if (!isRecord(info) || !isSafeInteger(info.count) || info.count < 0 ||
          !isSafeInteger(info.page) || info.page !== page ||
          !isSafeInteger(info.per_page) || info.per_page <= 0 ||
          !isSafeInteger(info.total_count) || info.total_count < 0 ||
          info.count !== body.result.length || info.count > info.per_page ||
          requests > info.total_count) {
        throw new CloudflareAlertMetricsError(502, "Invalid AI Gateway pagination metadata.");
      }
      if (requests === info.total_count) return { cost, requests };
      if (body.result.length === 0) {
        throw new CloudflareAlertMetricsError(502, "AI Gateway pagination stopped early.");
      }
    }
    throw new CloudflareAlertMetricsError(507, "AI Gateway cost query exceeded its page bound.");
  }

  /** List stored Overseer object IDs without instantiating missing or deleted Durable Objects. */
  async queryOverseerObjectIds(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DURABLE_OBJECT_PAGES; page++) {
      const search = new URLSearchParams({ limit: String(DURABLE_OBJECT_PAGE_SIZE) });
      if (cursor) search.set("cursor", cursor);
      const response = await this.#request(
        `${API_BASE}/accounts/${this.#config.accountId}/workers/durable_objects/namespaces/` +
          `${this.#config.overseerNamespaceId}/objects?${search}`,
        { method: "GET", headers: { Accept: "application/json" } },
      );
      const body = await readBoundedJson(response);
      if (!response.ok || !isRecord(body) || body.success !== true || !Array.isArray(body.result) ||
          !isRecord(body.result_info)) {
        throw new CloudflareAlertMetricsError(
          response.status || 502,
          "Cloudflare Durable Object inventory request failed.",
          providerCodes(body),
        );
      }
      for (const object of body.result) {
        if (!isRecord(object) || typeof object.id !== "string" ||
            !/^[0-9a-f]{64}$/i.test(object.id) || typeof object.hasStoredData !== "boolean") {
          throw new CloudflareAlertMetricsError(502, "Invalid Durable Object inventory row.");
        }
        if (object.hasStoredData) ids.push(object.id.toLowerCase());
      }
      const nextCursor = body.result_info.cursor;
      if (nextCursor === undefined || nextCursor === null || nextCursor === "") return ids;
      if (typeof nextCursor !== "string" || nextCursor.length > 4096 || nextCursor === cursor) {
        throw new CloudflareAlertMetricsError(502, "Invalid Durable Object inventory cursor.");
      }
      cursor = nextCursor;
    }
    throw new CloudflareAlertMetricsError(507, "Durable Object inventory exceeded its page bound.");
  }
}
