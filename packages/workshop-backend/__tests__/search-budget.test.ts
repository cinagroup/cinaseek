import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { searchBudgetCases } from "./search-budget-cases.js";

// The normal backend suite always runs this in workerd; no fallback to Node is allowed.
searchBudgetCases(async test => {
  const stub = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_user, ctx) => test(ctx.storage.kv));
});
