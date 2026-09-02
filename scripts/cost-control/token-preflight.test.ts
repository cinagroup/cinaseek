import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloudflareAlertMetricsError } from "./cloudflare-alert-metrics.ts";
import { verifyCostControlToken } from "./token-preflight.ts";

describe("cost-control token preflight", () => {
  it("passes only after exercising every required production capability", async () => {
    const calls: string[] = [];
    const result = await verifyCostControlToken({
      async queryOverseerHourlyCost() { calls.push("analytics"); return []; },
      async queryAiGatewayCost() { calls.push("gateway"); return { cost: 0, requests: 0 }; },
      async queryOverseerObjectIds() { calls.push("objects"); return []; },
      async queryLogMetrics() { calls.push("observability"); return []; },
    }, new Date("2026-09-02T06:00:00.000Z"));

    assert.equal(result.ok, true);
    assert.deepEqual(calls.toSorted(), ["analytics", "gateway", "objects", "observability"]);
    assert.deepEqual(result.capabilities, {
      accountAnalytics: { ok: true, codes: [] },
      aiGateway: { ok: true, codes: [] },
      durableObjects: { ok: true, codes: [] },
      workersObservability: { ok: true, codes: [] },
    });
  });

  it("reports only bounded status and numeric codes for failed capabilities", async () => {
    const token = "must-never-appear";
    const result = await verifyCostControlToken({
      async queryOverseerHourlyCost() {
        throw new CloudflareAlertMetricsError(403, `provider echoed ${token}`, [10000]);
      },
      async queryAiGatewayCost() { return { cost: 0, requests: 0 }; },
      async queryOverseerObjectIds() { throw new Error(`provider echoed ${token}`); },
      async queryLogMetrics() { return []; },
    }, new Date("2026-09-02T06:00:00.000Z"));

    assert.equal(result.ok, false);
    assert.deepEqual(result.capabilities.accountAnalytics, {
      ok: false,
      status: 403,
      codes: [10000],
    });
    assert.deepEqual(result.capabilities.durableObjects, { ok: false, codes: [] });
    assert.doesNotMatch(JSON.stringify(result), /must-never-appear|provider echoed/);
  });
});
