/** Stable identifiers for the nine production cost-control alerts. */
export type CostControlAlertId =
  | "do_cost_per_active_workspace"
  | "workspace_session_completion"
  | "workspace_reopen_slo"
  | "realtime_security"
  | "realtime_handshake_failure_rate"
  | "workspace_blob_integrity"
  | "dynamic_worker_growth"
  | "usage_limit_or_stale_reservation"
  | "unit_cost_growth";

/** Evaluation state persisted between closed monitoring windows. */
export interface CostControlAlertState {
  /** Schema version for forward-compatible persisted state. */
  version: 1;
  /** Last conclusive state for each alert. Missing data never clears a firing alert. */
  lastStatuses: Partial<Record<CostControlAlertId, "ok" | "firing">>;
  /** Number of consecutive closed hourly windows with a unit-cost breach. */
  unitCostConsecutiveBreachHours: number;
  /** Last closed hourly window already incorporated into the consecutive-hour counter. */
  lastUnitCostWindowId?: string;
}

/** One closed-window sample consumed by the deterministic alert evaluator. */
export interface CostControlSample {
  /** ISO timestamp at which this complete sample was evaluated. */
  observedAt: string;
  /** Durable Object GB-s divided by active workspace count, current and same-hour baseline. */
  doGbSecondsPerActiveWorkspace?: { current: number; baseline: number };
  /** Workspace session pair counts over the closed 30-minute window. */
  workspaceSessions?: { started: number; finished: number };
  /** Client-observed workspace reopen outcomes and seven-day p95 baseline. */
  workspaceReopens?: {
    successful: number;
    failed: number;
    dataLosses: number;
    p95DurationMs?: number;
    baselineP95DurationMs?: number;
  };
  /** Immediate security-significant realtime events. */
  realtimeSecurity?: { ticketConfigurationErrors: number; crossWorkspaceMismatches: number };
  /** Realtime handshake outcomes over the closed 15-minute window. */
  realtimeHandshakes?: { successful: number; failed: number };
  /** Workspace blob failures and reconciled orphan bytes. */
  workspaceBlobs?: { mirrorFailures: number; deletionFailures: number; orphanBytes: number };
  /** Current and previous seven-day Dynamic Worker and edited-revision counts. */
  dynamicWorkers?: {
    currentDistinct: number;
    baselineDistinct: number;
    currentEditedRevisions: number;
    baselineEditedRevisions: number;
  };
  /** Usage-limit comparison and stale active reservation count. */
  usageReservations?: {
    usageLimitOutcomes: number;
    baselineUsageLimitOutcomes: number;
    staleActiveReservations: number;
  };
  /** Unit economics for one complete hourly window and its seven-day same-hour baseline. */
  unitCost?: {
    windowId: string;
    perSuccessfulRun?: { current: number; baseline: number };
    perInteractiveWorkspaceHour?: { current: number; baseline: number };
  };
}

/** Conclusive or data-quality result for one alert. */
export interface CostControlAlertResult {
  /** Stable alert identifier. */
  id: CostControlAlertId;
  /** `insufficient_data` is non-conclusive and never auto-recovers an existing firing alert. */
  status: "ok" | "firing" | "insufficient_data";
  /** Human-readable, secret-free explanation suitable for a structured alert log. */
  reason: string;
  /** Bounded numeric evidence used by the decision. */
  observed: Record<string, number>;
}

/** State transition that should be emitted to the notification route. */
export interface CostControlAlertTransition {
  /** Stable alert identifier. */
  id: CostControlAlertId;
  /** A new incident or the conclusive recovery of an existing incident. */
  type: "firing" | "recovered";
  /** Explanation copied from the current evaluation result. */
  reason: string;
}

/** Complete deterministic evaluation output. */
export interface CostControlEvaluation {
  /** One result for each required alert, in stable runbook order. */
  results: CostControlAlertResult[];
  /** Only incident/recovery edges; repeated firing samples do not page repeatedly. */
  transitions: CostControlAlertTransition[];
  /** State to persist atomically after emitting transitions. */
  nextState: CostControlAlertState;
}

/** Return a clean initial state for a new deployment. */
export function initialCostControlAlertState(): CostControlAlertState {
  return {
    version: 1,
    lastStatuses: {},
    unitCostConsecutiveBreachHours: 0,
  };
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validCounts(values: number[]): boolean {
  return values.every(isNonNegativeFinite);
}

function result(
  id: CostControlAlertId,
  status: CostControlAlertResult["status"],
  reason: string,
  observed: Record<string, number> = {},
): CostControlAlertResult {
  return { id, status, reason, observed };
}

function growthRatio(current: number, baseline: number): number | undefined {
  if (!isNonNegativeFinite(current) || !isNonNegativeFinite(baseline) || baseline <= 0) {
    return undefined;
  }
  return current / baseline;
}

function evaluateDoCost(sample: CostControlSample): CostControlAlertResult {
  const values = sample.doGbSecondsPerActiveWorkspace;
  if (!values) {
    return result("do_cost_per_active_workspace", "insufficient_data", "DO cost sample is absent.");
  }
  const ratio = growthRatio(values.current, values.baseline);
  if (ratio === undefined) {
    return result(
      "do_cost_per_active_workspace",
      "insufficient_data",
      "DO cost sample requires finite non-negative values and a positive baseline.",
    );
  }
  const observed = { current: values.current, baseline: values.baseline, ratio };
  return ratio > 1.3
    ? result(
        "do_cost_per_active_workspace",
        "firing",
        "DO GB-s per active workspace is more than 30% above the same-hour baseline.",
        observed,
      )
    : result(
        "do_cost_per_active_workspace",
        "ok",
        "DO GB-s per active workspace is within 30% of the same-hour baseline.",
        observed,
      );
}

function evaluateWorkspaceSessions(sample: CostControlSample): CostControlAlertResult {
  const values = sample.workspaceSessions;
  if (!values || !validCounts([values.started, values.finished]) || values.started === 0) {
    return result(
      "workspace_session_completion",
      "insufficient_data",
      "Workspace session evaluation requires a positive start count and valid finish count.",
    );
  }
  const ratio = values.finished / values.started;
  const observed = { started: values.started, finished: values.finished, ratio };
  return ratio < 0.95
    ? result(
        "workspace_session_completion",
        "firing",
        "Workspace session finish/start ratio is below 95% for the closed 30-minute window.",
        observed,
      )
    : result(
        "workspace_session_completion",
        "ok",
        "Workspace session finish/start ratio is at least 95%.",
        observed,
      );
}

function evaluateWorkspaceReopens(sample: CostControlSample): CostControlAlertResult {
  const values = sample.workspaceReopens;
  if (!values || !validCounts([values.successful, values.failed, values.dataLosses])) {
    return result(
      "workspace_reopen_slo",
      "insufficient_data",
      "Workspace reopen outcome sample is absent or invalid.",
    );
  }
  const total = values.successful + values.failed;
  const failureRate = total > 0 ? values.failed / total : 0;
  const observed: Record<string, number> = {
    successful: values.successful,
    failed: values.failed,
    total,
    failureRate,
    dataLosses: values.dataLosses,
  };
  if (values.dataLosses > 0) {
    return result(
      "workspace_reopen_slo",
      "firing",
      "A workspace reopen reported lost draft or attachment state.",
      observed,
    );
  }
  if (total === 0) {
    return result(
      "workspace_reopen_slo",
      "insufficient_data",
      "Workspace reopen evaluation requires at least one outcome.",
      observed,
    );
  }
  if (failureRate > 0.005) {
    return result(
      "workspace_reopen_slo",
      "firing",
      "Workspace reopen error rate is above 0.5% for the closed 30-minute window.",
      observed,
    );
  }
  const p95 = values.p95DurationMs;
  const baselineP95 = values.baselineP95DurationMs;
  const ratio = p95 === undefined || baselineP95 === undefined
    ? undefined
    : growthRatio(p95, baselineP95);
  if (ratio === undefined) {
    return result(
      "workspace_reopen_slo",
      "insufficient_data",
      "Workspace reopen latency requires finite p95 values and a positive seven-day baseline.",
      observed,
    );
  }
  Object.assign(observed, { p95DurationMs: p95, baselineP95DurationMs: baselineP95, ratio });
  return ratio > 1.2
    ? result(
        "workspace_reopen_slo",
        "firing",
        "Workspace reopen p95 latency is more than 20% above the seven-day baseline.",
        observed,
      )
    : result(
        "workspace_reopen_slo",
        "ok",
        "Workspace reopen errors, latency, and client-state integrity are within thresholds.",
        observed,
      );
}

function evaluateRealtimeSecurity(sample: CostControlSample): CostControlAlertResult {
  const values = sample.realtimeSecurity;
  if (!values || !validCounts([
    values.ticketConfigurationErrors,
    values.crossWorkspaceMismatches,
  ])) {
    return result("realtime_security", "insufficient_data", "Realtime security sample is absent or invalid.");
  }
  const observed = {
    ticketConfigurationErrors: values.ticketConfigurationErrors,
    crossWorkspaceMismatches: values.crossWorkspaceMismatches,
  };
  return values.ticketConfigurationErrors + values.crossWorkspaceMismatches > 0
    ? result(
        "realtime_security",
        "firing",
        "A realtime ticket configuration error or cross-workspace mismatch occurred.",
        observed,
      )
    : result("realtime_security", "ok", "No realtime security event occurred.", observed);
}

function evaluateRealtimeHandshakes(sample: CostControlSample): CostControlAlertResult {
  const values = sample.realtimeHandshakes;
  if (!values || !validCounts([values.successful, values.failed])) {
    return result(
      "realtime_handshake_failure_rate",
      "insufficient_data",
      "Realtime handshake sample is absent or invalid.",
    );
  }
  const total = values.successful + values.failed;
  if (total === 0) {
    return result(
      "realtime_handshake_failure_rate",
      "insufficient_data",
      "Realtime handshake rate requires at least one outcome.",
    );
  }
  const rate = values.failed / total;
  const observed = { successful: values.successful, failed: values.failed, total, rate };
  return rate > 0.005
    ? result(
        "realtime_handshake_failure_rate",
        "firing",
        "Realtime handshake failure rate is above 0.5% for the closed 15-minute window.",
        observed,
      )
    : result(
        "realtime_handshake_failure_rate",
        "ok",
        "Realtime handshake failure rate is at or below 0.5%.",
        observed,
      );
}

function evaluateWorkspaceBlobs(sample: CostControlSample): CostControlAlertResult {
  const values = sample.workspaceBlobs;
  if (!values || !validCounts([
    values.mirrorFailures,
    values.deletionFailures,
    values.orphanBytes,
  ])) {
    return result(
      "workspace_blob_integrity",
      "insufficient_data",
      "Workspace blob integrity sample is absent or invalid.",
    );
  }
  const observed = {
    mirrorFailures: values.mirrorFailures,
    deletionFailures: values.deletionFailures,
    orphanBytes: values.orphanBytes,
  };
  return values.mirrorFailures + values.deletionFailures + values.orphanBytes > 0
    ? result(
        "workspace_blob_integrity",
        "firing",
        "Workspace blob mirror/deletion failures or reconciled orphan bytes are above zero.",
        observed,
      )
    : result("workspace_blob_integrity", "ok", "Workspace blob integrity checks are clean.", observed);
}

function evaluateDynamicWorkers(sample: CostControlSample): CostControlAlertResult {
  const values = sample.dynamicWorkers;
  if (!values || !validCounts([
    values.currentDistinct,
    values.baselineDistinct,
    values.currentEditedRevisions,
    values.baselineEditedRevisions,
  ])) {
    return result("dynamic_worker_growth", "insufficient_data", "Dynamic Worker sample is absent or invalid.");
  }
  const workerRatio = growthRatio(values.currentDistinct, values.baselineDistinct);
  if (workerRatio === undefined) {
    return result(
      "dynamic_worker_growth",
      "insufficient_data",
      "Dynamic Worker evaluation requires a positive prior seven-day count.",
    );
  }
  const revisionRatio = values.baselineEditedRevisions > 0
    ? values.currentEditedRevisions / values.baselineEditedRevisions
    : values.currentEditedRevisions > 0
      ? Number.POSITIVE_INFINITY
      : 1;
  const observed = {
    currentDistinct: values.currentDistinct,
    baselineDistinct: values.baselineDistinct,
    workerRatio,
    currentEditedRevisions: values.currentEditedRevisions,
    baselineEditedRevisions: values.baselineEditedRevisions,
    revisionRatio,
  };
  return workerRatio > 1.25 && revisionRatio < workerRatio
    ? result(
        "dynamic_worker_growth",
        "firing",
        "Distinct Dynamic Workers grew by more than 25% without matching edited-revision growth.",
        observed,
      )
    : result(
        "dynamic_worker_growth",
        "ok",
        "Dynamic Worker growth is within 25% or matched by edited-revision growth.",
        observed,
      );
}

function evaluateUsageReservations(sample: CostControlSample): CostControlAlertResult {
  const values = sample.usageReservations;
  if (!values || !validCounts([
    values.usageLimitOutcomes,
    values.baselineUsageLimitOutcomes,
    values.staleActiveReservations,
  ])) {
    return result(
      "usage_limit_or_stale_reservation",
      "insufficient_data",
      "Usage-limit and reservation sample is absent or invalid.",
    );
  }
  const usageRatio = growthRatio(values.usageLimitOutcomes, values.baselineUsageLimitOutcomes);
  const observed = {
    usageLimitOutcomes: values.usageLimitOutcomes,
    baselineUsageLimitOutcomes: values.baselineUsageLimitOutcomes,
    usageRatio: usageRatio ?? 0,
    staleActiveReservations: values.staleActiveReservations,
  };
  if (values.staleActiveReservations > 0) {
    return result(
      "usage_limit_or_stale_reservation",
      "firing",
      "One or more active quota reservations exceeded the supported run duration.",
      observed,
    );
  }
  if (usageRatio === undefined) {
    return result(
      "usage_limit_or_stale_reservation",
      "insufficient_data",
      "Usage-limit growth requires a positive baseline when no stale reservation exists.",
      observed,
    );
  }
  return usageRatio > 1.5
    ? result(
        "usage_limit_or_stale_reservation",
        "firing",
        "Agent usage-limit outcomes are more than 50% above baseline.",
        observed,
      )
    : result(
        "usage_limit_or_stale_reservation",
        "ok",
        "Usage-limit growth is within 50% and no stale reservation exists.",
        observed,
      );
}

function unitCostBreach(values: CostControlSample["unitCost"]): {
  conclusive: boolean;
  breach: boolean;
  observed: Record<string, number>;
} {
  if (!values || !values.windowId) return { conclusive: false, breach: false, observed: {} };
  let conclusive = false;
  let breach = false;
  const observed: Record<string, number> = {};
  for (const [name, pair] of [
    ["perSuccessfulRun", values.perSuccessfulRun],
    ["perInteractiveWorkspaceHour", values.perInteractiveWorkspaceHour],
  ] as const) {
    if (!pair) continue;
    const ratio = growthRatio(pair.current, pair.baseline);
    if (ratio === undefined) continue;
    conclusive = true;
    observed[`${name}Current`] = pair.current;
    observed[`${name}Baseline`] = pair.baseline;
    observed[`${name}Ratio`] = ratio;
    if (ratio > 1.2) breach = true;
  }
  return { conclusive, breach, observed };
}

function evaluateUnitCost(
  sample: CostControlSample,
  state: CostControlAlertState,
): { result: CostControlAlertResult; breachHours: number; windowId?: string } {
  const checked = unitCostBreach(sample.unitCost);
  if (!checked.conclusive) {
    return {
      result: result(
        "unit_cost_growth",
        "insufficient_data",
        "Unit-cost evaluation requires a positive seven-day baseline for at least one metric.",
      ),
      breachHours: state.unitCostConsecutiveBreachHours,
      windowId: state.lastUnitCostWindowId,
    };
  }
  const windowId = sample.unitCost!.windowId;
  const isNewWindow = windowId !== state.lastUnitCostWindowId;
  const breachHours = isNewWindow
    ? checked.breach ? state.unitCostConsecutiveBreachHours + 1 : 0
    : state.unitCostConsecutiveBreachHours;
  const observed = { ...checked.observed, consecutiveBreachHours: breachHours };
  if (breachHours >= 2) {
    return {
      result: result(
        "unit_cost_growth",
        "firing",
        "Unit cost is more than 20% above baseline for two consecutive closed hourly windows.",
        observed,
      ),
      breachHours,
      windowId,
    };
  }
  return {
    result: result(
      "unit_cost_growth",
      "ok",
      checked.breach
        ? "Unit cost is above 20%, but the two-consecutive-hour hold has not elapsed."
        : "Unit cost is within 20% of baseline.",
      observed,
    ),
    breachHours,
    windowId,
  };
}

/** Evaluate all nine runbook alerts and derive incident/recovery edges. */
export function evaluateCostControlAlerts(
  sample: CostControlSample,
  previousState: CostControlAlertState = initialCostControlAlertState(),
): CostControlEvaluation {
  if (!Number.isFinite(Date.parse(sample.observedAt))) {
    throw new Error("observedAt must be an ISO timestamp");
  }
  if (previousState.version !== 1) throw new Error("unsupported alert state version");

  const unitCost = evaluateUnitCost(sample, previousState);
  const results = [
    evaluateDoCost(sample),
    evaluateWorkspaceSessions(sample),
    evaluateWorkspaceReopens(sample),
    evaluateRealtimeSecurity(sample),
    evaluateRealtimeHandshakes(sample),
    evaluateWorkspaceBlobs(sample),
    evaluateDynamicWorkers(sample),
    evaluateUsageReservations(sample),
    unitCost.result,
  ];
  const nextStatuses = { ...previousState.lastStatuses };
  const transitions: CostControlAlertTransition[] = [];
  for (const current of results) {
    const previous = previousState.lastStatuses[current.id];
    if (current.status === "insufficient_data") continue;
    nextStatuses[current.id] = current.status;
    if (current.status === "firing" && previous !== "firing") {
      transitions.push({ id: current.id, type: "firing", reason: current.reason });
    } else if (current.status === "ok" && previous === "firing") {
      transitions.push({ id: current.id, type: "recovered", reason: current.reason });
    }
  }

  return {
    results,
    transitions,
    nextState: {
      version: 1,
      lastStatuses: nextStatuses,
      unitCostConsecutiveBreachHours: unitCost.breachHours,
      ...(unitCost.windowId ? { lastUnitCostWindowId: unitCost.windowId } : {}),
    },
  };
}
