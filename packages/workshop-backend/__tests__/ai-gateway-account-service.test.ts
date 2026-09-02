import { describe, expect, it } from "vitest";

import { fetchCreditBalance } from "../src/ai-gateway-billing/cloudflare/account-service";

describe("AI Gateway billing account service", () => {
  it("uses the current credit-balance endpoint and preserves its USD value", async () => {
    let requestedUrl = "";
    let authorization = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        success: true,
        result: { balance: 12.34 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(fetchCreditBalance("test-token", "account-id", fetchImpl)).resolves.toBe(12.34);
    expect(requestedUrl).toBe(
        "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/billing/credit-balance",
    );
    expect(authorization).toBe("Bearer test-token");
  });
});
