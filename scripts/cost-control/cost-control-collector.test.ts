import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectCostControlSample,
  planCostControlWindows,
} from "./cost-control-collector.ts";
import type { CloudflareAlertMetricsClient } from "./cloudflare-alert-metrics.ts";

const NOW = new Date("2026-09-02T04:37:00.000Z");

describe("cost-control collector", () => {
  it("aligns every metric to a complete UTC window", () => {
    const windows = planCostControlWindows(NOW);
    assert.equal(windows.observedAt.toISOString(), "2026-09-02T04:32:00.000Z");
    assert.equal(windows.realtime.from.toISOString(), "2026-09-02T04:15:00.000Z");
    assert.equal(windows.realtime.to.toISOString(), "2026-09-02T04:30:00.000Z");
    assert.equal(windows.workspaceSessions.from.toISOString(), "2026-09-02T04:00:00.000Z");
    assert.equal(windows.workspaceSessions.to.toISOString(), "2026-09-02T04:30:00.000Z");
    assert.equal(windows.workspaceReopenBaseline.from.toISOString(), "2026-08-26T04:00:00.000Z");
    assert.equal(windows.workspaceReopenBaseline.to.toISOString(), "2026-09-02T04:00:00.000Z");
    assert.equal(windows.attachmentReadBaseline.from.toISOString(), "2026-08-26T04:15:00.000Z");
    assert.equal(windows.attachmentReadBaseline.to.toISOString(), "2026-09-02T04:15:00.000Z");
    assert.equal(windows.hour.from.toISOString(), "2026-09-02T03:00:00.000Z");
    assert.equal(windows.hour.to.toISOString(), "2026-09-02T04:00:00.000Z");
    assert.equal(windows.baselineHours[0].from.toISOString(), "2026-08-26T03:00:00.000Z");
    assert.equal(windows.baselineHours[6].from.toISOString(), "2026-09-01T03:00:00.000Z");
    assert.deepEqual(windows.currentSevenDays, {
      fromDate: "2026-08-26",
      toDate: "2026-09-01",
      from: new Date("2026-08-26T00:00:00.000Z"),
      to: new Date("2026-09-02T00:00:00.000Z"),
    });
    assert.equal(windows.baselineSevenDays.fromDate, "2026-08-19");
    assert.equal(windows.baselineSevenDays.toDate, "2026-08-25");
  });

  it("builds a complete healthy sample and carries the reservation ledger", async () => {
    let baselineQueries = 0;
    let currentReadQueries = 0;
    const client = {
      async queryLogMetrics(from: Date, to: Date, events: string[]) {
        if (events.includes("realtime.ticket.config.invalid")) {
          return [
            { event: "cost.metric.realtime.handshake.succeeded", count: 1_000, durationMs: 0 },
            { event: "cost.metric.realtime.handshake.failed", count: 5, durationMs: 0 },
          ];
        }
        if (events.includes("chat.attachment.r2.mirror.failed")) {
          return [{
            event: "chat.attachment.r2.read.completed",
            operation: "read",
            count: 2,
            durationMs: 0,
          }];
        }
        if (events.includes("workspace.reopen.data_lost")) {
          return [
            {
              event: "cost.metric.workspace.reopen.finished",
              operation: "ok",
              count: 199,
              durationMs: 0,
              p95DurationMs: 120,
            },
            {
              event: "cost.metric.workspace.reopen.finished",
              operation: "error",
              count: 1,
              durationMs: 0,
            },
          ];
        }
        if (events.includes("cost.metric.workspace.session.started")) {
          return [
            { event: "cost.metric.workspace.session.started", count: 100, durationMs: 0 },
            { event: "cost.metric.workspace.session.finished", count: 96, durationMs: 0 },
          ];
        }
        if (events.includes("cost.metric.gadget.revision.edited")) {
          return [{
            event: "cost.metric.gadget.revision.edited",
            count: from < new Date("2026-08-26T00:00:00Z") ? 8 : 10,
            durationMs: 0,
          }];
        }
        const current = from >= new Date("2026-09-02T03:00:00Z");
        return [
          {
            event: "cost.metric.agent.run.finished",
            operation: "ok",
            count: current ? 12 : 10,
            durationMs: 0,
          },
          {
            event: "cost.metric.agent.run.finished",
            operation: "usage_limit",
            count: current ? 1 : 1,
            durationMs: 0,
          },
          {
            event: "cost.metric.workspace.session.finished",
            operation: "normal",
            count: 1,
            durationMs: HOUR_MS,
          },
        ];
      },
      async queryLogDurationValues(from: Date, to: Date, event: string) {
        if (event === "chat.attachment.r2.read.completed" &&
            to.valueOf() - from.valueOf() === 15 * 60_000) {
          currentReadQueries++;
          return [40, 50];
        }
        baselineQueries++;
        return event === "chat.attachment.r2.read.completed"
          ? [40, 50, 60]
          : [80, 90, 100];
      },
      async queryOverseerHourlyCost(from: Date) {
        return [{
          hour: from.toISOString(),
          durationGbSeconds: 10,
          activeWorkspaces: 1,
          gbSecondsPerActiveWorkspace: 10,
        }];
      },
      async queryDistinctDynamicWorkers(fromDate: string) {
        return fromDate === "2026-08-26" ? 110 : 100;
      },
      async queryAiGatewayCost(from: Date) {
        return { cost: from >= new Date("2026-09-02T03:00:00Z") ? 1.2 : 1, requests: 1 };
      },
      async queryReservationEvents() {
        return [{
          executionId: "00000000-0000-4000-8000-000000000001",
          type: "created" as const,
          timestamp: new Date("2026-09-02T04:25:00Z").valueOf(),
        }];
      },
    } as unknown as CloudflareAlertMetricsClient;

    const collected = await collectCostControlSample(
      client,
      NOW,
      { activeReservations: {} },
      { agentMaxDurationMs: 30 * 60_000, queryWorkspaceOrphanBytes: async () => 0 },
    );

    assert.deepEqual(collected.failures, []);
    assert.deepEqual(collected.sample.workspaceSessions, { started: 100, finished: 96 });
    assert.deepEqual(collected.sample.workspaceReopens, {
      successful: 199,
      failed: 1,
      dataLosses: 0,
      p95DurationMs: 120,
      baselineP95DurationMs: 100,
    });
    assert.deepEqual(collected.sample.realtimeSecurity, {
      ticketConfigurationErrors: 0,
      crossWorkspaceMismatches: 0,
    });
    assert.deepEqual(collected.sample.realtimeHandshakes, { successful: 1_000, failed: 5 });
    assert.deepEqual(collected.sample.workspaceBlobs, {
      mirrorFailures: 0,
      writeFailures: 0,
      readFailures: 0,
      deletionFailures: 0,
      orphanBytes: 0,
      successfulReads: 2,
      p95ReadDurationMs: 50,
      baselineP95ReadDurationMs: 60,
    });
    assert.deepEqual(collected.sample.dynamicWorkers, {
      currentDistinct: 110,
      baselineDistinct: 100,
      currentEditedRevisions: 10,
      baselineEditedRevisions: 8,
    });
    assert.equal(collected.sample.usageReservations?.staleActiveReservations, 0);
    assert.ok(Math.abs((collected.sample.unitCost?.perSuccessfulRun?.current ?? 0) - 0.1) < 1e-12);
    assert.ok(Math.abs((collected.sample.unitCost?.perSuccessfulRun?.baseline ?? 0) - 0.1) < 1e-12);
    assert.equal(Object.keys(collected.nextState.activeReservations).length, 1);
    assert.equal(collected.nextState.workspaceReopenBaseline?.p95DurationMs, 100);
    assert.equal(collected.nextState.attachmentReadBaseline?.p95DurationMs, 60);
    assert.equal(baselineQueries, 2);
    assert.equal(currentReadQueries, 1);

    const repeated = await collectCostControlSample(
      client,
      new Date("2026-09-02T04:52:00.000Z"),
      collected.nextState,
      { agentMaxDurationMs: 30 * 60_000, queryWorkspaceOrphanBytes: async () => 0 },
    );
    assert.equal(repeated.sample.workspaceReopens?.baselineP95DurationMs, 100);
    assert.equal(repeated.sample.workspaceBlobs?.baselineP95ReadDurationMs, 60);
    assert.equal(baselineQueries, 2);
    assert.equal(currentReadQueries, 2);
  });

  it("isolates one failed source and leaves its alert input absent", async () => {
    const client = {
      async queryLogMetrics() { return []; },
      async queryLogDurationValues() { return []; },
      async queryOverseerHourlyCost() { throw Object.assign(new Error("secret provider text"), {
        status: 403,
        codes: [9109],
        failureKind: "same_zone_fetch",
      }); },
      async queryDistinctDynamicWorkers() { return 0; },
      async queryAiGatewayCost() { return { cost: 0, requests: 0 }; },
      async queryReservationEvents() { return []; },
    } as unknown as CloudflareAlertMetricsClient;

    const collected = await collectCostControlSample(
      client,
      NOW,
      { activeReservations: {} },
      { agentMaxDurationMs: 30 * 60_000 },
    );

    assert.equal(collected.sample.doGbSecondsPerActiveWorkspace, undefined);
    assert.ok(collected.failures.length >= 1);
    assert.deepEqual(collected.failures[0], {
      source: "do_current_hour",
      status: 403,
      codes: [9109],
      failureKind: "same_zone_fetch",
    });
    assert.doesNotMatch(JSON.stringify(collected.failures), /secret provider text/);
    assert.equal(collected.sample.workspaceBlobs, undefined);
  });

  it("requires all seven same-hour DO baseline samples before evaluating growth", async () => {
    const missingBaselineHour = new Date("2026-08-29T03:00:00.000Z").valueOf();
    const client = {
      async queryLogMetrics() { return []; },
      async queryLogDurationValues() { return []; },
      async queryOverseerHourlyCost(from: Date) {
        if (from.valueOf() === missingBaselineHour) return [];
        return [{
          hour: from.toISOString(),
          durationGbSeconds: 10,
          activeWorkspaces: 1,
          gbSecondsPerActiveWorkspace: 10,
        }];
      },
      async queryDistinctDynamicWorkers() { return 0; },
      async queryAiGatewayCost() { return { cost: 0, requests: 0 }; },
      async queryReservationEvents() { return []; },
    } as unknown as CloudflareAlertMetricsClient;

    const collected = await collectCostControlSample(
      client,
      NOW,
      { activeReservations: {} },
      { agentMaxDurationMs: 30 * 60_000 },
    );

    assert.equal(collected.sample.doGbSecondsPerActiveWorkspace, undefined);
    assert.deepEqual(collected.failures, []);
  });
});

const HOUR_MS = 60 * 60_000;
