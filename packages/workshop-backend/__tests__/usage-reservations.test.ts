import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

describe("daily LLM quota reservations", () => {
  it("holds the final allowance atomically and can release or consume it idempotently", async () => {
    let stub = env.TEST_USER.getByName("daily-llm-reservations");
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      let firstId = "11111111-1111-4111-8111-111111111111";
      let secondId = "22222222-2222-4222-8222-222222222222";

      await expect(user.reserveDailyLlmCall(1, firstId)).resolves.toMatchObject({
        withinLimits: true,
        used: 1,
        reserved: 1,
        remaining: 0,
      });
      await expect(user.reserveDailyLlmCall(1, secondId)).resolves.toMatchObject({
        withinLimits: false,
        used: 1,
        reserved: 1,
      });

      await user.settleDailyLlmCall(firstId, false);
      await expect(user.reserveDailyLlmCall(1, secondId)).resolves.toMatchObject({
        withinLimits: true,
        used: 1,
        reserved: 1,
      });

      await user.settleDailyLlmCall(secondId, true);
      await user.settleDailyLlmCall(secondId, true);
      await expect(user.checkDailyLlmCount(1)).resolves.toMatchObject({
        withinLimits: false,
        used: 1,
        reserved: 0,
        remaining: 0,
      });
    });
  });
});
