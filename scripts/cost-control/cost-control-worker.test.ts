import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CostControlSample } from "./alert-evaluator.ts";
import type { CloudflareAlertMetricsClient } from "./cloudflare-alert-metrics.ts";
import type { CostControlCollection } from "./cost-control-collector.ts";
import {
  runCostControlMonitor,
  type CostControlWorkerEnv,
} from "./cost-control-worker.ts";

const SCHEDULED_TIME = new Date("2026-09-02T05:00:00.000Z").valueOf();

function sample(): CostControlSample {
  return {
    observedAt: "2026-09-02T04:55:00.000Z",
    realtimeSecurity: { ticketConfigurationErrors: 1, crossWorkspaceMismatches: 0 },
  };
}

function environment(initial: unknown = null) {
  let stored = initial;
  let writes = 0;
  const env: CostControlWorkerEnv = {
    ALERT_STATE: {
      async get<T>() { return stored as T | null; },
      async put(_key, value) { stored = JSON.parse(value); writes++; },
    },
    CLOUDFLARE_ACCOUNT_ID: "7ea8e46d8210bad342fa7595f7935fea",
    CLOUDFLARE_API_TOKEN: "test-token-never-log",
    BACKEND_SERVICE: "cinaseek-ai-backend",
    OVERSEER_NAMESPACE_ID: "64a9194b91ec4384861e876e18c1baf3",
    AI_GATEWAY_ID: "cinaos-ai",
    AGENT_MAX_DURATION_MS: "1800000",
    DEPLOYMENT_NAME: "test",
  };
  return { env, stored: () => stored, writes: () => writes };
}

function collector(result: CostControlSample = sample()) {
  return async (): Promise<CostControlCollection> => ({
    sample: result,
    nextState: {
      activeReservations: {
        "00000000-0000-4000-8000-000000000001": SCHEDULED_TIME,
      },
      lastReservationScanAt: result.observedAt,
    },
    failures: [{ source: "do_current_hour", status: 403, codes: [9109] }],
  });
}

describe("cost-control scheduled Worker", () => {
  it("logs one firing edge and commits evaluator plus collector state", async () => {
    const fixture = environment();
    const logs: Record<string, unknown>[] = [];
    const evaluation = await runCostControlMonitor(fixture.env, SCHEDULED_TIME, {
      client: {} as CloudflareAlertMetricsClient,
      collect: collector(),
      log: record => logs.push(record),
    });

    assert.deepEqual(evaluation.transitions.map(({ id, type }) => ({ id, type })), [{
      id: "realtime_security",
      type: "firing",
    }]);
    assert.equal(fixture.writes(), 1);
    assert.equal(
      (fixture.stored() as { alerts: { lastStatuses: Record<string, string> } })
        .alerts.lastStatuses.realtime_security,
      "firing",
    );
    assert.ok(logs.some(log => log.event === "cost.alert.source.failed"));
    assert.equal(logs.filter(log => log.event === "cost.alert.firing").length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /test-token-never-log/);
  });

  it("does not commit state when the incident webhook fails", async () => {
    const fixture = environment();
    fixture.env.ALERT_WEBHOOK_URL = "https://alerts.example.test/cinaseek";
    fixture.env.ALERT_WEBHOOK_TOKEN = "webhook-token-never-log";
    let authorization: string | null = null;

    await assert.rejects(
      () => runCostControlMonitor(fixture.env, SCHEDULED_TIME, {
        client: {} as CloudflareAlertMetricsClient,
        collect: collector(),
        log: () => undefined,
        fetch: async (_url, init) => {
          authorization = new Headers(init?.headers).get("Authorization");
          return new Response(null, { status: 503 });
        },
      }),
      /HTTP 503/,
    );
    assert.equal(authorization, "Bearer webhook-token-never-log");
    assert.equal(fixture.writes(), 0);
  });

  it("fails closed on corrupt persisted state", async () => {
    const fixture = environment({ version: 99 });
    await assert.rejects(
      () => runCostControlMonitor(fixture.env, SCHEDULED_TIME, {
        client: {} as CloudflareAlertMetricsClient,
        collect: collector(),
      }),
      /state version/,
    );
    assert.equal(fixture.writes(), 0);
  });

  it("emits exactly one recovery after a persisted incident", async () => {
    const fixture = environment({
      version: 1,
      alerts: {
        version: 1,
        lastStatuses: { realtime_security: "firing" },
        unitCostConsecutiveBreachHours: 0,
      },
      collector: { activeReservations: {} },
    });
    const healthy = sample();
    healthy.realtimeSecurity = { ticketConfigurationErrors: 0, crossWorkspaceMismatches: 0 };
    const evaluation = await runCostControlMonitor(fixture.env, SCHEDULED_TIME, {
      client: {} as CloudflareAlertMetricsClient,
      collect: collector(healthy),
      log: () => undefined,
    });

    assert.deepEqual(evaluation.transitions.map(({ id, type }) => ({ id, type })), [{
      id: "realtime_security",
      type: "recovered",
    }]);
  });
});
