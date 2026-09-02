import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateCostControlAlerts,
  initialCostControlAlertState,
  type CostControlSample,
} from "./alert-evaluator.ts";

const OBSERVED_AT = "2026-09-02T04:00:00.000Z";

function healthySample(): CostControlSample {
  return {
    observedAt: OBSERVED_AT,
    doGbSecondsPerActiveWorkspace: { current: 12.9, baseline: 10 },
    workspaceSessions: { started: 100, finished: 95 },
    realtimeSecurity: { ticketConfigurationErrors: 0, crossWorkspaceMismatches: 0 },
    realtimeHandshakes: { successful: 995, failed: 5 },
    workspaceBlobs: { mirrorFailures: 0, deletionFailures: 0, orphanBytes: 0 },
    dynamicWorkers: {
      currentDistinct: 125,
      baselineDistinct: 100,
      currentEditedRevisions: 10,
      baselineEditedRevisions: 10,
    },
    usageReservations: {
      usageLimitOutcomes: 15,
      baselineUsageLimitOutcomes: 10,
      staleActiveReservations: 0,
    },
    unitCost: {
      windowId: "2026-09-02T03:00:00Z",
      perSuccessfulRun: { current: 1.2, baseline: 1 },
      perInteractiveWorkspaceHour: { current: 2.4, baseline: 2 },
    },
  };
}

describe("cost-control alert evaluator", () => {
  it("treats exact thresholds as healthy and returns all eight alerts in stable order", () => {
    const evaluation = evaluateCostControlAlerts(healthySample());

    assert.equal(evaluation.results.length, 8);
    assert.deepEqual(evaluation.results.map(({ id }) => id), [
      "do_cost_per_active_workspace",
      "workspace_session_completion",
      "realtime_security",
      "realtime_handshake_failure_rate",
      "workspace_blob_integrity",
      "dynamic_worker_growth",
      "usage_limit_or_stale_reservation",
      "unit_cost_growth",
    ]);
    assert.deepEqual(evaluation.results.map(({ status }) => status), Array(8).fill("ok"));
    assert.deepEqual(evaluation.transitions, []);
  });

  it("fires every alert when its strict threshold is crossed", () => {
    const sample = healthySample();
    sample.doGbSecondsPerActiveWorkspace = { current: 13.01, baseline: 10 };
    sample.workspaceSessions = { started: 100, finished: 94 };
    sample.realtimeSecurity = { ticketConfigurationErrors: 1, crossWorkspaceMismatches: 0 };
    sample.realtimeHandshakes = { successful: 994, failed: 6 };
    sample.workspaceBlobs = { mirrorFailures: 0, deletionFailures: 1, orphanBytes: 0 };
    sample.dynamicWorkers = {
      currentDistinct: 126,
      baselineDistinct: 100,
      currentEditedRevisions: 10,
      baselineEditedRevisions: 10,
    };
    sample.usageReservations = {
      usageLimitOutcomes: 16,
      baselineUsageLimitOutcomes: 10,
      staleActiveReservations: 0,
    };
    sample.unitCost = {
      windowId: "2026-09-02T04:00:00Z",
      perSuccessfulRun: { current: 1.21, baseline: 1 },
    };
    const first = evaluateCostControlAlerts(sample, {
      ...initialCostControlAlertState(),
      unitCostConsecutiveBreachHours: 1,
      lastUnitCostWindowId: "2026-09-02T03:00:00Z",
    });

    assert.deepEqual(first.results.map(({ status }) => status), Array(8).fill("firing"));
    assert.deepEqual(first.transitions.map(({ type }) => type), Array(8).fill("firing"));
  });

  it("pages once, retains firing state through missing data, and emits one recovery", () => {
    const firingSample = healthySample();
    firingSample.realtimeSecurity = { ticketConfigurationErrors: 0, crossWorkspaceMismatches: 1 };
    const first = evaluateCostControlAlerts(firingSample);
    assert.deepEqual(first.transitions, [{
      id: "realtime_security",
      type: "firing",
      reason: "A realtime ticket configuration error or cross-workspace mismatch occurred.",
    }]);

    const repeated = evaluateCostControlAlerts(firingSample, first.nextState);
    assert.deepEqual(repeated.transitions, []);

    const missing = healthySample();
    delete missing.realtimeSecurity;
    const unknown = evaluateCostControlAlerts(missing, repeated.nextState);
    assert.equal(unknown.nextState.lastStatuses.realtime_security, "firing");
    assert.deepEqual(unknown.transitions, []);

    const recovered = evaluateCostControlAlerts(healthySample(), unknown.nextState);
    assert.deepEqual(recovered.transitions.map(({ id, type }) => ({ id, type })), [{
      id: "realtime_security",
      type: "recovered",
    }]);
  });

  it("requires two distinct closed hourly windows for the unit-cost alert", () => {
    const firstSample = healthySample();
    firstSample.unitCost = {
      windowId: "2026-09-02T03:00:00Z",
      perSuccessfulRun: { current: 1.21, baseline: 1 },
    };
    const first = evaluateCostControlAlerts(firstSample);
    assert.equal(first.results.at(-1)?.status, "ok");
    assert.equal(first.nextState.unitCostConsecutiveBreachHours, 1);

    const sameWindow = evaluateCostControlAlerts(firstSample, first.nextState);
    assert.equal(sameWindow.nextState.unitCostConsecutiveBreachHours, 1);
    assert.equal(sameWindow.results.at(-1)?.status, "ok");

    const secondSample = healthySample();
    secondSample.unitCost = {
      windowId: "2026-09-02T04:00:00Z",
      perInteractiveWorkspaceHour: { current: 2.41, baseline: 2 },
    };
    const second = evaluateCostControlAlerts(secondSample, sameWindow.nextState);
    assert.equal(second.nextState.unitCostConsecutiveBreachHours, 2);
    assert.equal(second.results.at(-1)?.status, "firing");
    assert.equal(second.transitions.at(-1)?.type, "firing");
  });

  it("treats stale reservations as an immediate alert even with a zero usage baseline", () => {
    const sample = healthySample();
    sample.usageReservations = {
      usageLimitOutcomes: 0,
      baselineUsageLimitOutcomes: 0,
      staleActiveReservations: 1,
    };
    const evaluation = evaluateCostControlAlerts(sample);
    assert.equal(
      evaluation.results.find(({ id }) => id === "usage_limit_or_stale_reservation")?.status,
      "firing",
    );
  });

  it("requires Dynamic Worker growth to exceed revision growth", () => {
    const sample = healthySample();
    sample.dynamicWorkers = {
      currentDistinct: 150,
      baselineDistinct: 100,
      currentEditedRevisions: 15,
      baselineEditedRevisions: 10,
    };
    let evaluation = evaluateCostControlAlerts(sample);
    assert.equal(
      evaluation.results.find(({ id }) => id === "dynamic_worker_growth")?.status,
      "ok",
    );

    sample.dynamicWorkers.currentEditedRevisions = 14;
    evaluation = evaluateCostControlAlerts(sample);
    assert.equal(
      evaluation.results.find(({ id }) => id === "dynamic_worker_growth")?.status,
      "firing",
    );
  });

  it("fails closed on invalid timestamps and unknown persisted-state versions", () => {
    assert.throws(
      () => evaluateCostControlAlerts({ ...healthySample(), observedAt: "not-a-time" }),
      /observedAt/,
    );
    assert.throws(
      () => evaluateCostControlAlerts(healthySample(), {
        ...initialCostControlAlertState(),
        version: 2 as 1,
      }),
      /state version/,
    );
  });
});
