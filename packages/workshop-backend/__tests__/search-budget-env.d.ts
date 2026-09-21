/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { SearchBudgetTestHooks } from "./worker.js";
import type { UserDurableObject } from "../src/user.js";

declare global {
  namespace Cloudflare {
    interface Env {
      // Test-only bindings from vitest.config.ts; production generated Env remains unchanged.
      TEST_SEARCH_BUDGET: DurableObjectNamespace<SearchBudgetTestHooks>;
      TEST_USER: DurableObjectNamespace<UserDurableObject>;
    }
  }
}
