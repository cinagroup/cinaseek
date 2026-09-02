import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CloudflareAlertMetricsClient,
  CloudflareAlertMetricsError,
  countStaleReservations,
} from "./cloudflare-alert-metrics.ts";

const CONFIG = {
  accountId: "7ea8e46d8210bad342fa7595f7935fea",
  apiToken: "test-token-never-log",
  backendService: "cinaseek-ai-backend",
  overseerNamespaceId: "64a9194b91ec4384861e876e18c1baf3",
  aiGatewayId: "cinaos-ai",
};
const FROM = new Date("2026-09-02T03:00:00.000Z");
const TO = new Date("2026-09-02T04:00:00.000Z");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Cloudflare alert metrics client", () => {
  it("builds one scoped observability aggregation and merges calculation rows", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = new CloudflareAlertMetricsClient(CONFIG, async (url, init) => {
      requests.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body));
      const alias = body.parameters.calculations[0].alias;
      return jsonResponse({
        success: true,
        result: {
          calculations: alias === "count"
            ? [{
              alias: "count",
              aggregates: [{
                value: 4,
                groups: [
                  { key: "event", value: "cost.metric.agent.run.finished" },
                  { key: "operation", value: "ok" },
                ],
              }],
            }]
            : [{
              alias: "durationMs",
              aggregates: [{
                value: 1200,
                groups: [
                  { key: "event", value: "cost.metric.agent.run.finished" },
                  { key: "operation", value: "ok" },
                ],
              }],
            }],
        },
      });
    });

    const rows = await client.queryLogMetrics(
      FROM,
      TO,
      ["cost.metric.agent.run.finished", "cost.metric.workspace.session.started"],
      { groupByOperation: true, includeDuration: true },
    );

    assert.deepEqual(rows, [{
      event: "cost.metric.agent.run.finished",
      operation: "ok",
      count: 4,
      durationMs: 1200,
    }]);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /workers\/observability\/telemetry\/query$/);
    const body = JSON.parse(String(requests[0].init?.body));
    assert.deepEqual(body.parameters.filters[0], {
      kind: "filter",
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: "cinaseek-ai-backend",
    });
    assert.deepEqual(body.parameters.filters[1], {
      kind: "group",
      filterCombination: "or",
      filters: [
        {
          kind: "filter",
          key: "event",
          operation: "eq",
          type: "string",
          value: "cost.metric.agent.run.finished",
        },
        {
          kind: "filter",
          key: "event",
          operation: "eq",
          type: "string",
          value: "cost.metric.workspace.session.started",
        },
      ],
    });
    assert.equal(requests[0].init?.headers &&
      (requests[0].init.headers as Record<string, string>).Authorization,
    "Bearer test-token-never-log");
    assert.equal(requests[0].init?.signal, undefined);
  });

  it("removes surrounding whitespace from a deployment secret before authentication", async () => {
    let authorization: string | undefined;
    const client = new CloudflareAlertMetricsClient({
      ...CONFIG,
      apiToken: "\r\n  test-token-never-log  \r\n",
    }, async (_url, init) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return jsonResponse({ success: true, result: { calculations: [] } });
    });

    await client.queryLogMetrics(FROM, TO, ["cost.metric.workspace.session.started"]);

    assert.equal(authorization, "Bearer test-token-never-log");
  });

  it("classifies request construction failures without exposing their text", async () => {
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => {
      throw new TypeError("Invalid header contained test-token-never-log");
    });

    await assert.rejects(
      client.queryLogMetrics(FROM, TO, ["cost.metric.workspace.session.started"]),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareAlertMetricsError);
        assert.equal(error.status, 502);
        assert.equal(error.failureKind, "invalid_header");
        assert.doesNotMatch(error.message, /test-token|Invalid header/);
        return true;
      },
    );
  });

  it("invokes an injected fetch without binding the metrics client as its receiver", async () => {
    let receiver: unknown = "not-called";
    const fetchImpl = async function(this: unknown): Promise<Response> {
      receiver = this;
      return jsonResponse({ success: true, result: { calculations: [] } });
    } as typeof fetch;
    const client = new CloudflareAlertMetricsClient(CONFIG, fetchImpl);

    await client.queryLogMetrics(FROM, TO, ["cost.metric.workspace.session.started"]);

    assert.equal(receiver, undefined);
  });

  it("aggregates hourly DO duration and distinct Overseer objects", async () => {
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => jsonResponse({
      data: {
        viewer: {
          accounts: [{
            durableObjectsPeriodicGroups: [
              {
                dimensions: { datetimeHour: "2026-09-02T03:00:00Z", objectId: "one" },
                sum: { duration: 10 },
              },
              {
                dimensions: { datetimeHour: "2026-09-02T03:00:00Z", objectId: "two" },
                sum: { duration: 20 },
              },
              {
                dimensions: { datetimeHour: "2026-09-02T03:00:00Z", objectId: "one" },
                sum: { duration: 2 },
              },
            ],
          }],
        },
      },
    }));

    assert.deepEqual(await client.queryOverseerHourlyCost(FROM, TO), [{
      hour: "2026-09-02T03:00:00Z",
      durationGbSeconds: 32,
      activeWorkspaces: 2,
      gbSecondsPerActiveWorkspace: 16,
    }]);
  });

  it("reads the authoritative Dynamic Worker count", async () => {
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => jsonResponse({
      data: {
        viewer: {
          accounts: [{
            workersInvocationsByOwnerAndScriptGroups: [
              { uniq: { distinctDynamicWorkerCount: 7 } },
            ],
          }],
        },
      },
    }));

    assert.equal(await client.queryDistinctDynamicWorkers("2026-08-26", "2026-09-01"), 7);
  });

  it("rejects ambiguous Dynamic Worker grouped rows instead of double-counting", async () => {
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => jsonResponse({
      data: {
        viewer: {
          accounts: [{
            workersInvocationsByOwnerAndScriptGroups: [
              { uniq: { distinctDynamicWorkerCount: 7 } },
              { uniq: { distinctDynamicWorkerCount: 8 } },
            ],
          }],
        },
      },
    }));

    await assert.rejects(
      () => client.queryDistinctDynamicWorkers("2026-08-26", "2026-09-01"),
      /ambiguous/,
    );
  });

  it("fully paginates and sums AI Gateway costs", async () => {
    let calls = 0;
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => {
      calls++;
      return jsonResponse({
        success: true,
        result: calls === 1 ? [{ cost: 1.25 }, { cost: 0.5 }] : [{ cost: 0.25 }],
        result_info: {
          count: calls === 1 ? 2 : 1,
          page: calls,
          per_page: 2,
          total_count: 3,
        },
      });
    });

    assert.deepEqual(await client.queryAiGatewayCost(FROM, TO), { cost: 2, requests: 3 });
    assert.equal(calls, 2);
  });

  it("accepts the official zero-log pagination shape", async () => {
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => jsonResponse({
      success: true,
      result: [],
      result_info: { count: 0, page: 1, per_page: 50, total_count: 0 },
    }));

    assert.deepEqual(await client.queryAiGatewayCost(FROM, TO), { cost: 0, requests: 0 });
  });

  it("paginates stored Overseer object IDs without exposing deleted objects", async () => {
    let calls = 0;
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => {
      calls++;
      return jsonResponse({
        success: true,
        result: calls === 1
          ? [
              { id: "a".repeat(64), hasStoredData: true },
              { id: "b".repeat(64), hasStoredData: false },
            ]
          : [{ id: "c".repeat(64), hasStoredData: true }],
        result_info: { cursor: calls === 1 ? "next-page" : null },
      });
    });

    assert.deepEqual(await client.queryOverseerObjectIds(), ["a".repeat(64), "c".repeat(64)]);
    assert.equal(calls, 2);
  });

  it("correlates reservation edges and counts only old unmatched creates", () => {
    const old = "00000000-0000-4000-8000-000000000001";
    const settled = "00000000-0000-4000-8000-000000000002";
    const recent = "00000000-0000-4000-8000-000000000003";
    assert.equal(countStaleReservations([
      { executionId: settled, type: "settled", timestamp: 30 },
      { executionId: old, type: "created", timestamp: 10 },
      { executionId: settled, type: "created", timestamp: 20 },
      { executionId: recent, type: "created", timestamp: 90 },
    ], 50), 1);
  });

  it("uses an explicit OR group for reservation lifecycle events", async () => {
    let request: { init?: RequestInit } | undefined;
    const client = new CloudflareAlertMetricsClient(CONFIG, async (_url, init) => {
      request = { init };
      return jsonResponse({
        success: true,
        result: { events: { count: 0, events: [] } },
      });
    });

    assert.deepEqual(await client.queryReservationEvents(FROM, TO), []);
    const body = JSON.parse(String(request!.init?.body));
    assert.deepEqual(body.parameters.filters[1], {
      kind: "group",
      filterCombination: "or",
      filters: [
        {
          kind: "filter",
          key: "event",
          operation: "eq",
          type: "string",
          value: "usage.reservation.created",
        },
        {
          kind: "filter",
          key: "event",
          operation: "eq",
          type: "string",
          value: "usage.reservation.settled",
        },
      ],
    });
  });

  it("bounds provider errors without exposing provider text or the token", async () => {
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => jsonResponse({
      success: false,
      errors: [{ code: 9109, message: "echoed caller value and test-token-never-log" }],
    }, 403));

    await assert.rejects(
      () => client.queryAiGatewayCost(FROM, TO),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareAlertMetricsError);
        assert.equal(error.status, 403);
        assert.deepEqual(error.codes, [9109]);
        assert.doesNotMatch(error.message, /test-token|echoed/);
        return true;
      },
    );
  });
});
