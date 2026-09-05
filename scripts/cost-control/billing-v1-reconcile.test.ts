import assert from "node:assert/strict";
import test from "node:test";

import {
  collectAndReconcileBillingV1,
  reconcileBillingV1,
  type BillingAttributionInput,
} from "./billing-v1-reconcile.ts";

const ACCOUNT_ID = "7ea8e46d8210bad342fa7595f7935fea";
const TOKEN = "private-test-token";
const NOW = new Date("2026-09-16T12:00:00Z");

function isoDay(index: number): string {
  return new Date(Date.UTC(2026, 8, 2 + index)).toISOString().slice(0, 10);
}

function attribution(cost = 1): BillingAttributionInput {
  return {
    schemaVersion: 1,
    currency: "USD",
    days: Array.from({ length: 14 }, (_, index) => ({
      day: isoDay(index),
      attributedCostUsd: cost,
    })),
  };
}

function billingRow(index: number, cost = 1): Record<string, unknown> {
  const start = `${isoDay(index)}T00:00:00Z`;
  const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();
  return {
    BillingAccountId: ACCOUNT_ID,
    BillingAccountName: "must-not-appear",
    BillingCurrency: "USD",
    ChargeCategory: "Usage",
    ChargeDescription: "must-not-appear",
    ChargePeriodStart: start,
    ChargePeriodEnd: end,
    BilledCost: cost,
    SubscriptionId: "must-not-appear",
  };
}

function provider(rows = Array.from({ length: 14 }, (_, index) => billingRow(index))): unknown {
  return { success: true, errors: [], messages: [], result: rows };
}

test("uses one read-only current-period request and returns a sanitized valid report", async () => {
  let calls = 0;
  const report = await collectAndReconcileBillingV1(attribution(1.1), ACCOUNT_ID, ` ${TOKEN} `, {
    now: NOW,
    fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.pathname, `/client/v4/accounts/${ACCOUNT_ID}/billable-usage`);
      assert.equal(url.search, "");
      assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(init?.body, undefined);
      return Response.json(provider());
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.valid, true);
  assert.equal(report.days.length, 14);
  assert.equal(report.days[0]?.deviationRatio, 0.1);
  assert.equal(report.providerRowsConsidered, 14);
  const serialized = JSON.stringify(report);
  for (const secret of [TOKEN, "must-not-appear", ACCOUNT_ID]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("fails the fixed gate when any daily deviation exceeds fifteen percent", () => {
  const report = reconcileBillingV1(attribution(1.16), provider(), ACCOUNT_ID, NOW);
  assert.equal(report.valid, false);
  assert.equal(report.days[0]?.withinTolerance, false);
  assert.match(report.issues[0] ?? "", /daily_deviation_above_15_percent/);
});

test("accepts the exact fifteen-percent boundary", () => {
  const report = reconcileBillingV1(attribution(1.15), provider(), ACCOUNT_ID, NOW);
  assert.equal(report.valid, true);
  assert.equal(report.days.every(day => day.deviationRatio === 0.15), true);
});

test("keeps aggregate deviation non-negative when usage adjustments are negative", () => {
  const rows = Array.from({ length: 14 }, (_, index) => billingRow(index, -1));
  const report = reconcileBillingV1(attribution(), provider(rows), ACCOUNT_ID, NOW);
  assert.equal(report.valid, false);
  assert.equal(report.totals.billedCostUsd, -14);
  assert.equal(report.totals.deviationRatio, 2);
});

test("does not interpret a missing provider day as zero billed cost", () => {
  const rows = Array.from({ length: 13 }, (_, index) => billingRow(index));
  const report = reconcileBillingV1(attribution(), provider(rows), ACCOUNT_ID, NOW);
  assert.equal(report.valid, false);
  assert.equal(report.days[13]?.billedCostUsd, undefined);
  assert.equal(report.issues.includes(`missing_billing_day:${isoDay(13)}`), true);
});

test("rejects gaps and open days in the attribution before reconciliation", () => {
  const withGap = attribution();
  withGap.days[5] = { day: "2026-09-20", attributedCostUsd: 1 };
  assert.throws(() => reconcileBillingV1(withGap, provider(), ACCOUNT_ID, NOW), /closed|consecutive/);
});

test("bounds provider failures to status and numeric codes", async () => {
  await assert.rejects(
    collectAndReconcileBillingV1(attribution(), ACCOUNT_ID, TOKEN, {
      now: NOW,
      fetch: async () => Response.json({
        success: false,
        errors: [{ code: 10000, message: `provider echoed ${TOKEN}` }],
      }, { status: 403 }),
    }),
    error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /status 403.*10000/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});
