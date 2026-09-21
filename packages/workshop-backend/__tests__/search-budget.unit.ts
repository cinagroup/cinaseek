import { searchBudgetCases } from "./search-budget-cases.js";

// Fast accounting-only evidence. This does not prove DO RPC, atomicity or restart persistence.
searchBudgetCases(async test => {
  const values = new Map<string, unknown>();
  test({
    get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    put<T>(key: string, value: T) { values.set(key, structuredClone(value)); },
  });
});
