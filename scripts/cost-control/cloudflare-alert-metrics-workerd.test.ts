import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { it } from "node:test";

// Use the pinned Wrangler runtime, as deployment does. The client has no imports, so Node's
// type erasure is enough to load its actual source in workerd without a second build pipeline.
const require = createRequire(import.meta.url);
const { Miniflare, Response: MockResponse, convertV4MiniflareOptions } =
  createRequire(require.resolve("wrangler/package.json"))("miniflare");
const source = stripTypeScriptTypes(readFileSync(new URL("./cloudflare-alert-metrics.ts", import.meta.url), "utf8"));

it("collects metrics and refuses redirects in real workerd without external requests", { timeout: 45_000 }, async () => {
  let calls = 0;
  let mode: "ok" | "retry" | "redirect" = "ok";
  let redirectStatus = 302;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: "2026-09-02",
    compatibilityFlags: ["global_fetch_strictly_public"],
    cf: false,
    host: "127.0.0.1",
    port: 0,
    script: `${source}
      export default { async fetch() {
        if (navigator.userAgent !== "Cloudflare-Workers") throw new Error("Expected workerd");
        const client = new CloudflareAlertMetricsClient({
          accountId: "a".repeat(32), apiToken: "fake-workerd-test-token",
          backendService: "test-backend", overseerNamespaceId: "b".repeat(32), aiGatewayId: "test-gateway",
        });
        try {
          const result = await client.queryAiGatewayCost(
            new Date("2026-09-05T00:00:00Z"), new Date("2026-09-05T01:00:00Z"),
          );
          return Response.json({ runtime: navigator.userAgent, result });
        } catch (error) {
          return Response.json({ runtime: navigator.userAgent, status: error.status, message: error.message });
        }
      } };
    `,
    // Intercept ALL destinations, including an erroneously followed redirect. No real token,
    // API request, remote binding or production state is involved in this test.
    outboundService: async (request: Request) => {
      calls++;
      assert.equal(new URL(request.url).hostname, "api.cloudflare.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer fake-workerd-test-token");
      if (mode === "redirect") {
        return new MockResponse("not JSON", { status: redirectStatus,
          headers: { Location: "https://redirect.invalid/private" } });
      }
      if (mode === "retry" && calls === 1) return new MockResponse("temporary", { status: 500 });
      return new MockResponse(JSON.stringify({ success: true, result: [{ cost: 0.5 }],
        result_info: { page: 1, count: 1, per_page: 50, total_count: 1 } }));
    },
  }));
  try {
    for (const nextMode of ["ok", "retry"] as const) {
      mode = nextMode;
      calls = 0;
      const response = await mf.dispatchFetch("http://localhost/");
      assert.deepEqual(await response.json(), {
        runtime: "Cloudflare-Workers", result: { cost: 0.5, requests: 1 },
      });
      assert.equal(calls, mode === "retry" ? 2 : 1);
    }
    mode = "redirect";
    for (const status of [301, 302, 303, 307, 308]) {
      redirectStatus = status;
      calls = 0;
      const response = await mf.dispatchFetch("http://localhost/");
      assert.deepEqual(await response.json(), {
        runtime: "Cloudflare-Workers", status,
        message: "Cloudflare metrics API redirects are not allowed.",
      });
      assert.equal(calls, 1);
    }
  } finally {
    await mf.dispose();
  }
});
