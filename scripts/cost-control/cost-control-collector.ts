import {
  CloudflareAlertMetricsClient,
  type CloudflareAlertMetricsFailureKind,
  type DurableObjectHourlyCost,
  type LogMetricGroup,
  type ReservationMetricEvent,
} from "./cloudflare-alert-metrics.ts";
import type { CostControlSample } from "./alert-evaluator.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_INGESTION_LAG_MS = 5 * MINUTE_MS;
const RESERVATION_OVERLAP_MS = 5 * MINUTE_MS;
const RESERVATION_SETTLEMENT_GRACE_MS = 10 * MINUTE_MS;
const MAX_RESERVATION_LEDGER_ENTRIES = 2_000;
const FAILURE_KINDS = new Set<CloudflareAlertMetricsFailureKind>([
  "timeout",
  "invalid_header",
  "same_zone_fetch",
  "cloudflare_address",
  "request_context",
  "unsupported_runtime",
  "access_restricted",
  "request_shape",
  "illegal_receiver",
  "network",
  "type_error",
  "unknown",
]);

interface DateRange {
  from: Date;
  to: Date;
}

/** Closed monitoring windows aligned in UTC. */
export interface CostControlWindows {
  /** Evaluation time after applying the ingestion lag. */
  observedAt: Date;
  /** Last complete 15-minute window. */
  realtime: DateRange;
  /** Last complete 30-minute window. */
  workspaceSessions: DateRange;
  /** Seven-day rolling baseline ending where the workspace-reopen window begins. */
  workspaceReopenBaseline: DateRange;
  /** Last complete UTC hour. */
  hour: DateRange;
  /** Same UTC hour on each of the previous seven days. */
  baselineHours: DateRange[];
  /** Last seven complete UTC dates, inclusive. */
  currentSevenDays: { fromDate: string; toDate: string; from: Date; to: Date };
  /** The seven complete UTC dates immediately before `currentSevenDays`. */
  baselineSevenDays: { fromDate: string; toDate: string; from: Date; to: Date };
}

/** Operational state that must survive scheduled monitor invocations. */
export interface CostControlCollectorState {
  /** Active reservation creation timestamps keyed by random execution ID. */
  activeReservations: Record<string, number>;
  /** End of the last successfully ingested reservation event window. */
  lastReservationScanAt?: string;
  /** Daily-refreshed seven-day workspace-reopen latency baseline. */
  workspaceReopenBaseline?: {
    /** Evaluation timestamp of the successful refresh. */
    refreshedAt: string;
    /** Inclusive start of the queried rolling window. */
    windowFrom: string;
    /** Exclusive end of the queried rolling window. */
    windowTo: string;
    /** Successful-reopen p95; absent when the completed window had no samples. */
    p95DurationMs?: number;
  };
}

/** A secret-free source failure that makes only the affected alert inconclusive. */
export interface CostControlSourceFailure {
  /** Stable source name. */
  source: string;
  /** HTTP-like status when exposed by the strict metrics client. */
  status?: number;
  /** Numeric Cloudflare error codes; provider-authored text is intentionally excluded. */
  codes?: readonly number[];
  /** Allowlisted runtime failure class when no provider response was received. */
  failureKind?: CloudflareAlertMetricsFailureKind;
}

/** Complete output from one best-effort metrics collection. */
export interface CostControlCollection {
  /** Partial sample; missing sources remain absent and evaluate as insufficient data. */
  sample: CostControlSample;
  /** Updated reservation ledger, committed together with alert state. */
  nextState: CostControlCollectorState;
  /** Secret-free failures suitable for structured operational logging. */
  failures: CostControlSourceFailure[];
}

/** Collector settings owned by the deployment, never by request data. */
export interface CostControlCollectorOptions {
  /** Supported maximum agent-run duration. */
  agentMaxDurationMs: number;
  /** Delay used to avoid querying partially ingested metrics. */
  ingestionLagMs?: number;
  /** Optional authoritative R2/metadata reconciliation. Omit until implemented. */
  queryWorkspaceOrphanBytes?: () => Promise<number>;
}

function floorDate(value: number, interval: number): Date {
  return new Date(Math.floor(value / interval) * interval);
}

function rangeEndingAt(to: Date, duration: number): DateRange {
  return { from: new Date(to.valueOf() - duration), to };
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Plan complete UTC monitoring windows without ever reading the still-open interval. */
export function planCostControlWindows(
  now: Date,
  ingestionLagMs = DEFAULT_INGESTION_LAG_MS,
): CostControlWindows {
  if (!Number.isFinite(now.valueOf()) || !Number.isSafeInteger(ingestionLagMs) ||
      ingestionLagMs < 0 || ingestionLagMs > HOUR_MS) {
    throw new Error("invalid cost-control window configuration");
  }
  const safeNow = now.valueOf() - ingestionLagMs;
  const realtimeEnd = floorDate(safeNow, 15 * MINUTE_MS);
  const sessionEnd = floorDate(safeNow, 30 * MINUTE_MS);
  const workspaceSessions = rangeEndingAt(sessionEnd, 30 * MINUTE_MS);
  const hourEnd = floorDate(safeNow, HOUR_MS);
  const hour = rangeEndingAt(hourEnd, HOUR_MS);
  const baselineHours = Array.from({ length: 7 }, (_, index) => ({
    from: new Date(hour.from.valueOf() - (index + 1) * DAY_MS),
    to: new Date(hour.to.valueOf() - (index + 1) * DAY_MS),
  })).toReversed();
  const dayEnd = floorDate(safeNow, DAY_MS);
  const currentFrom = new Date(dayEnd.valueOf() - 7 * DAY_MS);
  const baselineFrom = new Date(dayEnd.valueOf() - 14 * DAY_MS);
  return {
    observedAt: new Date(safeNow),
    realtime: rangeEndingAt(realtimeEnd, 15 * MINUTE_MS),
    workspaceSessions,
    workspaceReopenBaseline: {
      from: new Date(workspaceSessions.from.valueOf() - 7 * DAY_MS),
      to: workspaceSessions.from,
    },
    hour,
    baselineHours,
    currentSevenDays: {
      fromDate: utcDate(currentFrom),
      toDate: utcDate(new Date(dayEnd.valueOf() - DAY_MS)),
      from: currentFrom,
      to: dayEnd,
    },
    baselineSevenDays: {
      fromDate: utcDate(baselineFrom),
      toDate: utcDate(new Date(currentFrom.valueOf() - DAY_MS)),
      from: baselineFrom,
      to: currentFrom,
    },
  };
}

function metricCount(rows: LogMetricGroup[], event: string, operation?: string): number {
  return rows
    .filter(row => row.event === event && (operation === undefined || row.operation === operation))
    .reduce((total, row) => total + row.count, 0);
}

function metricDuration(rows: LogMetricGroup[], event: string): number {
  return rows.filter(row => row.event === event)
    .reduce((total, row) => total + row.durationMs, 0);
}

function metricP95(
  rows: LogMetricGroup[],
  event: string,
  operation: string,
): number | undefined {
  const values = rows
    .filter(row => row.event === event && row.operation === operation)
    .flatMap(row => row.p95DurationMs === undefined ? [] : [row.p95DurationMs]);
  return values.length === 1 && finiteNonNegative(values[0]) ? values[0] : undefined;
}

function percentile95(values: number[]): number | undefined {
  if (values.length === 0 || values.some(value => !finiteNonNegative(value))) return undefined;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function onlyHourlyCost(rows: DurableObjectHourlyCost[]): DurableObjectHourlyCost | undefined {
  return rows.length === 1 && rows[0].activeWorkspaces > 0 ? rows[0] : undefined;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function applyReservationEvents(
  ledger: Record<string, number>,
  events: ReservationMetricEvent[],
): Record<string, number> {
  const next = { ...ledger };
  for (const event of events.toSorted((left, right) => left.timestamp - right.timestamp)) {
    if (event.type === "created") next[event.executionId] = event.timestamp;
    else delete next[event.executionId];
  }
  if (Object.keys(next).length > MAX_RESERVATION_LEDGER_ENTRIES) {
    throw new Error("active reservation ledger exceeded its safe bound");
  }
  return next;
}

function failureFor(source: string, error: unknown): CostControlSourceFailure {
  if (typeof error === "object" && error !== null) {
    const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
    const codes = "codes" in error && Array.isArray(error.codes) &&
        error.codes.every(code => typeof code === "number")
      ? error.codes
      : undefined;
    const failureKind = "failureKind" in error && typeof error.failureKind === "string" &&
        FAILURE_KINDS.has(error.failureKind as CloudflareAlertMetricsFailureKind)
      ? error.failureKind as CloudflareAlertMetricsFailureKind
      : undefined;
    return {
      source,
      ...(status === undefined ? {} : { status }),
      ...(codes ? { codes } : {}),
      ...(failureKind ? { failureKind } : {}),
    };
  }
  return { source };
}

async function capture<T>(
  source: string,
  failures: CostControlSourceFailure[],
  operation: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    failures.push(failureFor(source, error));
    return undefined;
  }
}

const SESSION_EVENTS = [
  "cost.metric.workspace.session.started",
  "cost.metric.workspace.session.finished",
];
const REOPEN_EVENTS = [
  "cost.metric.workspace.reopen.finished",
  "workspace.reopen.data_lost",
];
const REALTIME_EVENTS = [
  "realtime.ticket.config.invalid",
  "realtime.workspace.mismatch",
  "cost.metric.realtime.handshake.succeeded",
  "cost.metric.realtime.handshake.failed",
];
const BLOB_EVENTS = [
  "chat.attachment.r2.mirror.failed",
  "chat.attachment.r2.write.failed",
  "chat.attachment.r2.read.missing",
  "chat.attachment.r2.delete.failed",
];
const HOURLY_EVENTS = [
  "cost.metric.agent.run.finished",
  "cost.metric.workspace.session.finished",
];

/** Collect all nine alert inputs while isolating failures to their dependent alert. */
export async function collectCostControlSample(
  client: CloudflareAlertMetricsClient,
  now: Date,
  state: CostControlCollectorState,
  options: CostControlCollectorOptions,
): Promise<CostControlCollection> {
  if (!Number.isSafeInteger(options.agentMaxDurationMs) ||
      options.agentMaxDurationMs < MINUTE_MS || options.agentMaxDurationMs > HOUR_MS) {
    throw new Error("agentMaxDurationMs must be between one minute and one hour");
  }
  const windows = planCostControlWindows(now, options.ingestionLagMs);
  const failures: CostControlSourceFailure[] = [];
  const refreshWorkspaceReopenBaseline =
    state.workspaceReopenBaseline === undefined ||
    utcDate(new Date(state.workspaceReopenBaseline.refreshedAt)) !== utcDate(windows.observedAt);

  const sessionsPromise = capture("workspace_sessions", failures, () =>
    client.queryLogMetrics(
      windows.workspaceSessions.from,
      windows.workspaceSessions.to,
      SESSION_EVENTS,
      { groupByOperation: true },
    ));
  const workspaceReopensPromise = capture("workspace_reopens", failures, () =>
    client.queryLogMetrics(
      windows.workspaceSessions.from,
      windows.workspaceSessions.to,
      REOPEN_EVENTS,
      { groupByOperation: true, includeDurationP95: true },
    ));
  const workspaceReopenBaselinePromise = refreshWorkspaceReopenBaseline
    ? capture("workspace_reopen_baseline", failures, () =>
        client.queryLogDurationValues(
          windows.workspaceReopenBaseline.from,
          windows.workspaceReopenBaseline.to,
          "cost.metric.workspace.reopen.finished",
          "ok",
        ))
    : Promise.resolve(null);
  const realtimePromise = capture("realtime", failures, () =>
    client.queryLogMetrics(
      windows.realtime.from,
      windows.realtime.to,
      REALTIME_EVENTS,
      { groupByOperation: true },
    ));
  const blobPromise = capture("workspace_blob_events", failures, () =>
    client.queryLogMetrics(windows.realtime.from, windows.realtime.to, BLOB_EVENTS));
  const currentDoPromise = capture("do_current_hour", failures, () =>
    client.queryOverseerHourlyCost(windows.hour.from, windows.hour.to));
  const baselineDoPromise = Promise.all(windows.baselineHours.map((range, index) =>
    capture(`do_baseline_hour_${index + 1}`, failures, () =>
      client.queryOverseerHourlyCost(range.from, range.to))));
  const currentHourlyPromise = capture("hourly_product_metrics", failures, () =>
    client.queryLogMetrics(
      windows.hour.from,
      windows.hour.to,
      HOURLY_EVENTS,
      { groupByOperation: true, includeDuration: true },
    ));
  const baselineHourlyPromise = Promise.all(windows.baselineHours.map((range, index) =>
    capture(`hourly_product_baseline_${index + 1}`, failures, () =>
      client.queryLogMetrics(range.from, range.to, HOURLY_EVENTS, {
        groupByOperation: true,
        includeDuration: true,
      }))));
  const currentAiPromise = capture("ai_gateway_current_hour", failures, () =>
    client.queryAiGatewayCost(windows.hour.from, windows.hour.to));
  const baselineAiPromise = Promise.all(windows.baselineHours.map((range, index) =>
    capture(`ai_gateway_baseline_hour_${index + 1}`, failures, () =>
      client.queryAiGatewayCost(range.from, range.to))));
  const dynamicCurrentPromise = capture("dynamic_workers_current_week", failures, () =>
    client.queryDistinctDynamicWorkers(
      windows.currentSevenDays.fromDate,
      windows.currentSevenDays.toDate,
    ));
  const dynamicBaselinePromise = capture("dynamic_workers_baseline_week", failures, () =>
    client.queryDistinctDynamicWorkers(
      windows.baselineSevenDays.fromDate,
      windows.baselineSevenDays.toDate,
    ));
  const revisionCurrentPromise = capture("edited_revisions_current_week", failures, () =>
    client.queryLogMetrics(
      windows.currentSevenDays.from,
      windows.currentSevenDays.to,
      ["cost.metric.gadget.revision.edited"],
    ));
  const revisionBaselinePromise = capture("edited_revisions_baseline_week", failures, () =>
    client.queryLogMetrics(
      windows.baselineSevenDays.from,
      windows.baselineSevenDays.to,
      ["cost.metric.gadget.revision.edited"],
    ));

  const reservationEnd = windows.observedAt;
  let reservationFrom = state.lastReservationScanAt
    ? new Date(Date.parse(state.lastReservationScanAt) - RESERVATION_OVERLAP_MS)
    : new Date(
        reservationEnd.valueOf() - options.agentMaxDurationMs * 2 -
          RESERVATION_SETTLEMENT_GRACE_MS,
      );
  if (!Number.isFinite(reservationFrom.valueOf()) || reservationFrom >= reservationEnd) {
    reservationFrom = new Date(
      reservationEnd.valueOf() - options.agentMaxDurationMs * 2 -
        RESERVATION_SETTLEMENT_GRACE_MS,
    );
  }
  const reservationEventsPromise = capture("usage_reservations", failures, () =>
    client.queryReservationEvents(reservationFrom, reservationEnd));
  const orphanBytesPromise = options.queryWorkspaceOrphanBytes
    ? capture("workspace_blob_reconciliation", failures, options.queryWorkspaceOrphanBytes)
    : Promise.resolve(undefined);

  const [
    sessions,
    workspaceReopens,
    workspaceReopenBaselineDurations,
    realtime,
    blobEvents,
    currentDoRows,
    baselineDoRows,
    currentHourly,
    baselineHourlyRows,
    currentAi,
    baselineAiRows,
    dynamicCurrent,
    dynamicBaseline,
    revisionCurrent,
    revisionBaseline,
    reservationEvents,
    orphanBytes,
  ] = await Promise.all([
    sessionsPromise,
    workspaceReopensPromise,
    workspaceReopenBaselinePromise,
    realtimePromise,
    blobPromise,
    currentDoPromise,
    baselineDoPromise,
    currentHourlyPromise,
    baselineHourlyPromise,
    currentAiPromise,
    baselineAiPromise,
    dynamicCurrentPromise,
    dynamicBaselinePromise,
    revisionCurrentPromise,
    revisionBaselinePromise,
    reservationEventsPromise,
    orphanBytesPromise,
  ]);

  const sample: CostControlSample = { observedAt: windows.observedAt.toISOString() };
  let nextWorkspaceReopenBaseline = state.workspaceReopenBaseline;
  if (workspaceReopenBaselineDurations !== undefined &&
      workspaceReopenBaselineDurations !== null) {
    const p95DurationMs = percentile95(workspaceReopenBaselineDurations);
    nextWorkspaceReopenBaseline = {
      refreshedAt: windows.observedAt.toISOString(),
      windowFrom: windows.workspaceReopenBaseline.from.toISOString(),
      windowTo: windows.workspaceReopenBaseline.to.toISOString(),
      ...(p95DurationMs === undefined ? {} : { p95DurationMs }),
    };
  }
  const baselineForEvaluation =
    refreshWorkspaceReopenBaseline && workspaceReopenBaselineDurations === undefined
      ? undefined
      : nextWorkspaceReopenBaseline;
  if (sessions) {
    sample.workspaceSessions = {
      started: metricCount(sessions, "cost.metric.workspace.session.started"),
      finished: metricCount(sessions, "cost.metric.workspace.session.finished"),
    };
  }
  if (workspaceReopens && baselineForEvaluation) {
    const p95DurationMs = metricP95(
      workspaceReopens,
      "cost.metric.workspace.reopen.finished",
      "ok",
    );
    const baselineP95DurationMs = baselineForEvaluation.p95DurationMs;
    sample.workspaceReopens = {
      successful: metricCount(
        workspaceReopens,
        "cost.metric.workspace.reopen.finished",
        "ok",
      ),
      failed: metricCount(
        workspaceReopens,
        "cost.metric.workspace.reopen.finished",
        "error",
      ),
      dataLosses: metricCount(workspaceReopens, "workspace.reopen.data_lost"),
      ...(p95DurationMs === undefined ? {} : { p95DurationMs }),
      ...(baselineP95DurationMs === undefined ? {} : { baselineP95DurationMs }),
    };
  }
  if (realtime) {
    sample.realtimeSecurity = {
      ticketConfigurationErrors: metricCount(realtime, "realtime.ticket.config.invalid"),
      crossWorkspaceMismatches: metricCount(realtime, "realtime.workspace.mismatch"),
    };
    sample.realtimeHandshakes = {
      successful: metricCount(realtime, "cost.metric.realtime.handshake.succeeded"),
      failed: metricCount(realtime, "cost.metric.realtime.handshake.failed"),
    };
  }
  if (blobEvents && orphanBytes !== undefined && finiteNonNegative(orphanBytes)) {
    sample.workspaceBlobs = {
      mirrorFailures:
        metricCount(blobEvents, "chat.attachment.r2.mirror.failed") +
        metricCount(blobEvents, "chat.attachment.r2.write.failed") +
        metricCount(blobEvents, "chat.attachment.r2.read.missing"),
      deletionFailures: metricCount(blobEvents, "chat.attachment.r2.delete.failed"),
      orphanBytes,
    };
  }

  const currentDo = currentDoRows ? onlyHourlyCost(currentDoRows) : undefined;
  const baselineDo = baselineDoRows.every(rows => rows !== undefined)
    ? mean(baselineDoRows.flatMap(rows => {
        const row = onlyHourlyCost(rows!);
        return row ? [row.gbSecondsPerActiveWorkspace] : [];
      }))
    : undefined;
  if (currentDo && baselineDo !== undefined) {
    sample.doGbSecondsPerActiveWorkspace = {
      current: currentDo.gbSecondsPerActiveWorkspace,
      baseline: baselineDo,
    };
  }

  const allBaselineHourly = baselineHourlyRows.every(rows => rows !== undefined)
    ? baselineHourlyRows.flatMap(rows => rows!)
    : undefined;
  if (currentHourly && allBaselineHourly) {
    const baselineUsage = metricCount(
      allBaselineHourly,
      "cost.metric.agent.run.finished",
      "usage_limit",
    ) / 7;
    let activeReservations = state.activeReservations;
    if (reservationEvents) {
      activeReservations = applyReservationEvents(activeReservations, reservationEvents);
    }
    if (reservationEvents) {
      const staleCutoff = windows.observedAt.valueOf() - options.agentMaxDurationMs -
        RESERVATION_SETTLEMENT_GRACE_MS;
      sample.usageReservations = {
        usageLimitOutcomes: metricCount(
          currentHourly,
          "cost.metric.agent.run.finished",
          "usage_limit",
        ),
        baselineUsageLimitOutcomes: baselineUsage,
        staleActiveReservations: Object.values(activeReservations)
          .filter(timestamp => timestamp < staleCutoff).length,
      };
    }
  }

  if (dynamicCurrent !== undefined && dynamicBaseline !== undefined &&
      revisionCurrent && revisionBaseline) {
    sample.dynamicWorkers = {
      currentDistinct: dynamicCurrent,
      baselineDistinct: dynamicBaseline,
      currentEditedRevisions: metricCount(
        revisionCurrent,
        "cost.metric.gadget.revision.edited",
      ),
      baselineEditedRevisions: metricCount(
        revisionBaseline,
        "cost.metric.gadget.revision.edited",
      ),
    };
  }

  if (currentHourly && allBaselineHourly && currentAi &&
      baselineAiRows.every(row => row !== undefined)) {
    const currentSuccessful = metricCount(
      currentHourly,
      "cost.metric.agent.run.finished",
      "ok",
    );
    const baselineSuccessful = metricCount(
      allBaselineHourly,
      "cost.metric.agent.run.finished",
      "ok",
    );
    const currentInteractiveHours = metricDuration(
      currentHourly,
      "cost.metric.workspace.session.finished",
    ) / HOUR_MS;
    const baselineInteractiveHours = metricDuration(
      allBaselineHourly,
      "cost.metric.workspace.session.finished",
    ) / HOUR_MS;
    const baselineCost = baselineAiRows.reduce((sum, row) => sum + row!.cost, 0);
    sample.unitCost = {
      windowId: windows.hour.from.toISOString(),
      ...(currentSuccessful > 0 && baselineSuccessful > 0
        ? {
            perSuccessfulRun: {
              current: currentAi.cost / currentSuccessful,
              baseline: baselineCost / baselineSuccessful,
            },
          }
        : {}),
      ...(currentInteractiveHours > 0 && baselineInteractiveHours > 0
        ? {
            perInteractiveWorkspaceHour: {
              current: currentAi.cost / currentInteractiveHours,
              baseline: baselineCost / baselineInteractiveHours,
            },
          }
        : {}),
    };
  }

  const nextReservations = reservationEvents
    ? applyReservationEvents(state.activeReservations, reservationEvents)
    : state.activeReservations;
  return {
    sample,
    nextState: {
      activeReservations: nextReservations,
      ...(reservationEvents
        ? { lastReservationScanAt: reservationEnd.toISOString() }
        : state.lastReservationScanAt
          ? { lastReservationScanAt: state.lastReservationScanAt }
          : {}),
      ...(nextWorkspaceReopenBaseline === undefined
        ? {}
        : { workspaceReopenBaseline: nextWorkspaceReopenBaseline }),
    },
    failures,
  };
}
