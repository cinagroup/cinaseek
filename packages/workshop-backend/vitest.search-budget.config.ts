import { defineConfig } from "vitest/config";

/** Explicit unit-only target. Does not replace vitest.config.ts or its assert-workerd guard. */
export default defineConfig({
  test: { environment: "node", include: ["__tests__/search-budget.unit.ts"] },
});
