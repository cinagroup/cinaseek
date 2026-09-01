import assert from "node:assert/strict";
import test from "node:test";
import { calculateCapacityModel } from "./capacity-model.mjs";

test("capacity model applies inclusions and unit sizes without embedding vendor rates", () => {
  const result = calculateCapacityModel({
    currency: "USD",
    meters: {
      doDuration: {quantity: 2_500_000, included: 1_000_000, unitSize: 1_000_000, pricePerUnit: 12.5},
      r2Storage: {quantity: 8, included: 10, pricePerUnit: 0.015},
      modelSpend: {quantity: 3.25, pricePerUnit: 1},
    },
  });

  assert.equal(result.total, 22);
  assert.deepEqual(result.breakdown.map(entry => entry.name), ["doDuration", "modelSpend", "r2Storage"]);
  assert.equal(result.breakdown[0].billableQuantity, 1_500_000);
  assert.equal(result.breakdown[2].cost, 0);
});

test("capacity model rejects missing and negative meter values", () => {
  assert.throws(() => calculateCapacityModel({meters: {bad: {quantity: -1, pricePerUnit: 1}}}),
      /bad\.quantity/);
  assert.throws(() => calculateCapacityModel({meters: {bad: {quantity: 1}}}),
      /bad\.pricePerUnit/);
});
