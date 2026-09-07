import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { CloudflareAlertMetricsClient, CloudflareAlertMetricsError } from "./cloudflare-alert-metrics.ts";

const CONFIG = {
  accountId: "a".repeat(32), apiToken: "test-secret-do-not-log",
  backendService: "test-backend", overseerNamespaceId: "b".repeat(32), aiGatewayId: "test-gateway",
};
const FROM = new Date("2026-09-05T00:00:00Z");
const TO = new Date("2026-09-05T01:00:00Z");
function page(pageNumber = 1): Response {
  return Response.json({ success: true, result: [{ cost: 0.5 }],
    result_info: { page: pageNumber, count: 1, per_page: 1, total_count: 2 } });
}
function failure(status: number, headers?: Record<string, string>): Response {
  return Response.json({ success: false, errors: [{ code: 7000, message: CONFIG.apiToken }] }, { status, headers });
}

describe("metrics transport resilience", () => {
  it("retries the same failed page once without double-counting prior cost", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pages: number[] = [];
    let discardedBodyCancelled = false;
    const client = new CloudflareAlertMetricsClient(CONFIG, async (url, init) => {
      assert.equal(init?.redirect, "error");
      assert.equal(init?.signal, undefined);
      const requestedPage = Number(new URL(String(url)).searchParams.get("page"));
      pages.push(requestedPage);
      if (pages.length === 2) return new Response(new ReadableStream({
        cancel() { discardedBodyCancelled = true; },
      }), { status: 500 });
      return page(requestedPage);
    });
    const result = client.queryAiGatewayCost(FROM, TO);
    await setImmediate();
    assert.deepEqual(pages, [1, 2]);
    t.mock.timers.tick(1_000);
    assert.deepEqual(await result, { cost: 1, requests: 2 });
    assert.deepEqual(pages, [1, 2, 2]);
    assert.equal(discardedBodyCancelled, true);
  });

  for (const status of [500, 502, 503, 504]) {
    it(`caps persistent HTTP ${status} at two attempts and preserves safe failure details`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let calls = 0;
      const client = new CloudflareAlertMetricsClient(CONFIG, async () => { calls++; return failure(status); });
      const rejected = assert.rejects(client.queryAiGatewayCost(FROM, TO), (error: unknown) => {
        assert.ok(error instanceof CloudflareAlertMetricsError);
        assert.equal(error.status, status);
        assert.deepEqual(error.codes, [7000]);
        assert.doesNotMatch(error.message, /test-secret/);
        return true;
      });
      await setImmediate();
      t.mock.timers.tick(1_000);
      await rejected;
      assert.equal(calls, 2);
    });
  }

  for (const status of [400, 401, 403, 429]) {
    it(`does not retry HTTP ${status}`, async () => {
      let calls = 0;
      const client = new CloudflareAlertMetricsClient(CONFIG, async () => { calls++; return failure(status); });
      await assert.rejects(client.queryAiGatewayCost(FROM, TO), { status });
      assert.equal(calls, 1);
    });
  }

  it("does not retry earlier than a provider Retry-After instruction", async () => {
    let calls = 0;
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => {
      calls++; return failure(503, { "Retry-After": "120" });
    });
    await assert.rejects(client.queryAiGatewayCost(FROM, TO), { status: 503 });
    assert.equal(calls, 1);
  });

  it("does not retry malformed successful responses or expose their content", async () => {
    let calls = 0;
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => { calls++; return new Response(CONFIG.apiToken); });
    await assert.rejects(client.queryAiGatewayCost(FROM, TO), /not valid JSON/);
    assert.equal(calls, 1);
  });

  it("bounds a stalled response body and cancels its reader", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let cancelled = false;
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    })));
    const rejected = assert.rejects(client.queryAiGatewayCost(FROM, TO), { status: 504, failureKind: "timeout" });
    await setImmediate();
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(cancelled, true);
  });

  it("retries only the identical dry Observability query", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const bodies: string[] = [];
    const client = new CloudflareAlertMetricsClient(CONFIG, async (_url, init) => {
      assert.equal(init?.method, "POST");
      const body = String(init?.body);
      assert.equal(JSON.parse(body).dry, true);
      bodies.push(body);
      return bodies.length === 1 ? failure(502) : Response.json({ success: true, result: { calculations: [] } });
    });
    const result = client.queryLogMetrics(FROM, TO, ["workspace.session.started"]);
    await setImmediate();
    t.mock.timers.tick(1_000);
    assert.deepEqual(await result, []);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  });

  it("retains the byte limit and cancels an oversized response without retrying", async () => {
    let cancelled = false;
    let calls = 0;
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      }));
    });
    await assert.rejects(client.queryAiGatewayCost(FROM, TO), /exceeded the size limit/);
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  });

  it("does not start a retry when the shared deadline expires during backoff", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const releaseBody = Promise.withResolvers<void>();
    const client = new CloudflareAlertMetricsClient(CONFIG, async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { return releaseBody.promise; } }), { status: 500 });
    });
    const rejected = assert.rejects(client.queryAiGatewayCost(FROM, TO), { status: 504, failureKind: "timeout" });
    await setImmediate();
    t.mock.timers.tick(29_800);
    releaseBody.resolve();
    await setImmediate();
    t.mock.timers.tick(200);
    await rejected;
    t.mock.timers.tick(5_000);
    await setImmediate();
    assert.equal(calls, 1);
  });

  it("shares one deadline across a retry and releases a late response without another request", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    let cancelled = false;
    const lateResponse = Promise.withResolvers<Response>();
    const client = new CloudflareAlertMetricsClient(CONFIG, async (_url, init) => {
      calls++;
      if (calls === 1) return failure(500);
      assert.equal(init?.signal, undefined);
      return lateResponse.promise;
    });
    const rejected = assert.rejects(client.queryAiGatewayCost(FROM, TO), { status: 504, failureKind: "timeout" });
    await setImmediate();
    t.mock.timers.tick(1_000);
    await setImmediate();
    assert.equal(calls, 2);
    t.mock.timers.tick(29_000);
    await rejected;
    lateResponse.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await setImmediate();
    assert.equal(cancelled, true);
    assert.equal(calls, 2);
  });
});
