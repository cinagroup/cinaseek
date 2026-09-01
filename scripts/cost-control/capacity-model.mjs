import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * Apply deployment-supplied billing rates to normalized usage meters. Rates deliberately live in
 * the input file rather than source code, because Cloudflare prices and account inclusions change.
 */
export function calculateCapacityModel(input) {
  if (!input || typeof input !== "object" || !input.meters || typeof input.meters !== "object") {
    throw new TypeError("capacity input must contain a meters object");
  }

  const breakdown = [];
  let total = 0;
  for (const [name, meter] of Object.entries(input.meters)) {
    if (!meter || typeof meter !== "object") throw new TypeError(`${name} must be an object`);
    const quantity = finiteNonNegative(meter.quantity, `${name}.quantity`);
    const included = finiteNonNegative(meter.included ?? 0, `${name}.included`);
    const unitSize = finitePositive(meter.unitSize ?? 1, `${name}.unitSize`);
    const pricePerUnit = finiteNonNegative(meter.pricePerUnit, `${name}.pricePerUnit`);
    const billableQuantity = Math.max(0, quantity - included);
    const units = billableQuantity / unitSize;
    const cost = units * pricePerUnit;
    total += cost;
    breakdown.push({name, quantity, included, billableQuantity, unitSize, pricePerUnit, cost});
  }

  return {
    currency: input.currency ?? "USD",
    total,
    breakdown: breakdown.toSorted((left, right) => right.cost - left.cost),
  };
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite positive number`);
  }
  return value;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: node scripts/cost-control/capacity-model.mjs <input.json>");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  process.stdout.write(`${JSON.stringify(calculateCapacityModel(input), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
