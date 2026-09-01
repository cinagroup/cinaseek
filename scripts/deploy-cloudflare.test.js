import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";

import {
  createInstanceConfigs,
  instanceSlug,
  normalizeAccessAudience,
  normalizeAccessIssuer,
  normalizeAiGatewayOptions,
  normalizeDomain,
  normalizeFlagshipAppId,
  normalizePipelineStreamId,
  parseArgs,
  planAiGatewaySecret,
  planRequiredWorkerSecrets,
  preserveProvisionedResources,
  verifyAccessEdge,
} from "./deploy-cloudflare.mjs";

const ROOT = resolve(import.meta.dirname, "..");

const accessChallenge = () => new Response(null, {
  status: 302,
  headers: {
    location: "https://cinagroup.cloudflareaccess.com/cdn-cgi/access/login/cinaseek.ai",
  },
});

test("normalizes and validates deployment domains", () => {
  assert.equal(normalizeDomain("CinaSeek.AI."), "cinaseek.ai");
  assert.equal(instanceSlug("cinaseek.ai"), "cinaseek-ai");
  assert.throws(() => normalizeDomain("https://cinaseek.ai"), /invalid domain/);
  assert.throws(() => normalizeDomain("localhost"), /invalid domain/);
});

test("rejects deployment options whose values are missing", () => {
  assert.throws(() => parseArgs(["--domain"]), /--domain requires a value/);
  assert.throws(() => parseArgs(["--domain", "--dry-run"]), /--domain requires a value/);
  assert.throws(() => parseArgs(["--domain", "cinaseek.ai", "--ai-gateway"]),
      /--ai-gateway requires a value/);
});

test("normalizes and validates Cloudflare Access settings", () => {
  assert.equal(
      normalizeAccessIssuer("https://CinaGroup.cloudflareaccess.com/"),
      "https://cinagroup.cloudflareaccess.com",
  );
  assert.equal(normalizeAccessAudience(" audience-tag "), "audience-tag");
  assert.throws(() => normalizeAccessIssuer("http://team.cloudflareaccess.com"),
      /invalid Cloudflare Access issuer/);
  assert.throws(() => normalizeAccessIssuer("https://example.com"),
      /invalid Cloudflare Access issuer/);
  assert.throws(() => normalizeAccessIssuer("https://team.cloudflareaccess.com:8443"),
      /invalid Cloudflare Access issuer/);
  assert.throws(() => normalizeAccessAudience("two values"),
      /invalid Cloudflare Access audience/);
  assert.throws(() => normalizeAccessAudience("x".repeat(65)),
      /invalid Cloudflare Access audience/);
});

test("verifies the Access edge challenge and RS256 signing keys", async () => {
  const requested = [];
  const signals = [];
  const responses = [
    new Response(null, {
      status: 302,
      headers: {
        location: "https://cinagroup.cloudflareaccess.com/cdn-cgi/access/login/cinaseek.ai",
      },
    }),
    new Response(null, {
      status: 302,
      headers: {
        location: "https://cinagroup.cloudflareaccess.com/cdn-cgi/access/login/cinaseek.ai",
      },
    }),
    new Response("Error: no 'state' provided", { status: 200 }),
    new Response(JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const fetchImpl = async (url, options) => {
    requested.push(String(url));
    signals.push(options.signal);
    return responses.shift();
  };

  await verifyAccessEdge({
    domain: "cinaseek.ai",
    issuer: "https://cinagroup.cloudflareaccess.com",
    fetchImpl,
  });
  assert.deepEqual(requested, [
    "https://cinaseek.ai/auth/login",
    "https://cinaseek.ai/api",
    "https://cinaseek.ai/gatekeeper/github/oauth",
    "https://cinagroup.cloudflareaccess.com/cdn-cgi/access/certs",
  ]);
  assert.equal(new Set(signals).size, 4);
});

test("fails Access preflight before deploy when protection or keys are wrong", async () => {
  await assert.rejects(() => verifyAccessEdge({
    domain: "cinaseek.ai",
    issuer: "https://cinagroup.cloudflareaccess.com",
    fetchImpl: async () => new Response("public", { status: 200 }),
  }), /is not challenging/);

  const wrongIssuerResponses = [
    new Response(null, {
      status: 302,
      headers: { location: "https://other.cloudflareaccess.com/cdn-cgi/access/login/cinaseek.ai" },
    }),
  ];
  await assert.rejects(() => verifyAccessEdge({
    domain: "cinaseek.ai",
    issuer: "https://cinagroup.cloudflareaccess.com",
    fetchImpl: async () => wrongIssuerResponses.shift(),
  }), /does not use/);

  const wrongKeyResponses = [
    new Response(null, {
      status: 302,
      headers: {
        location: "https://cinagroup.cloudflareaccess.com/cdn-cgi/access/login/cinaseek.ai",
      },
    }),
    new Response(null, {
      status: 302,
      headers: {
        location: "https://cinagroup.cloudflareaccess.com/cdn-cgi/access/login/cinaseek.ai",
      },
    }),
    new Response("Error: no 'state' provided", { status: 200 }),
    new Response(JSON.stringify({ keys: [{ kty: "EC", alg: "ES256" }] }), { status: 200 }),
  ];
  await assert.rejects(() => verifyAccessEdge({
    domain: "cinaseek.ai",
    issuer: "https://cinagroup.cloudflareaccess.com",
    fetchImpl: async () => wrongKeyResponses.shift(),
  }), /no RS256 signing key/);
});

test("normalizes and validates Cloudflare Flagship app IDs", () => {
  assert.equal(
      normalizeFlagshipAppId(" AB7716CE-3292-45EC-B654-E739E7815396 "),
      "ab7716ce-3292-45ec-b654-e739e7815396",
  );
  assert.throws(() => normalizeFlagshipAppId("cinaseek-production"), /Flagship app UUID/);
});

test("normalizes and validates Pipeline Stream IDs", () => {
  assert.equal(
      normalizePipelineStreamId(" 9DCF8722A58E453FB25E98EFB2ADEF63 "),
      "9dcf8722a58e453fb25e98efb2adef63",
  );
  assert.throws(() => normalizePipelineStreamId("cinaseek_stream"),
      /32-character Pipeline Stream ID/);
});

test("fails Access preflight when Gatekeeper OAuth is challenged", async () => {
  const responses = [accessChallenge(), accessChallenge(), accessChallenge()];
  await assert.rejects(() => verifyAccessEdge({
    domain: "cinaseek.ai",
    issuer: "https://cinagroup.cloudflareaccess.com",
    fetchImpl: async () => responses.shift(),
  }), /must not challenge.*gatekeeper\/github\/oauth/);
});

test("normalizes and validates AI Gateway settings", () => {
  assert.deepEqual(normalizeAiGatewayOptions({
    gateway: " CinaSeek_AI ",
    accountId: "7EA8E46D8210BAD342FA7595F7935FEA",
    providers: "openai, anthropic,openai-compatible,openai",
    workersAiDirect: true,
  }), {
    gateway: "CinaSeek_AI",
    accountId: "7ea8e46d8210bad342fa7595f7935fea",
    providers: ["openai", "anthropic", "openai-compatible"],
    workersAiGateway: undefined,
    workersAiDirect: true,
  });
  assert.equal(normalizeAiGatewayOptions(), undefined);
  assert.throws(() => normalizeAiGatewayOptions({ gateway: "cinaseek" }), /required together/);
  assert.throws(() => normalizeAiGatewayOptions({
    gateway: "cinaseek",
    accountId: "not-an-account",
    providers: "openai",
  }), /32-character Cloudflare account ID/);
  assert.throws(() => normalizeAiGatewayOptions({
    gateway: "cinaseek",
    accountId: "7ea8e46d8210bad342fa7595f7935fea",
    providers: "ollama",
  }), /unsupported AI Gateway provider: ollama/);
  assert.throws(() => normalizeAiGatewayOptions({
    gateway: "cinaseek",
    accountId: "7ea8e46d8210bad342fa7595f7935fea",
    providers: "openai",
    workersAiGateway: "workers-ai",
    workersAiDirect: true,
  }), /cannot be used together/);
});

test("fails closed unless the AI Gateway Worker secret can be verified", () => {
  assert.throws(() => planAiGatewaySecret(null, true), /Unable to verify the remote/);
  assert.throws(() => planAiGatewaySecret(new Set(), false),
      /requires the CF_AI_GATEWAY_API_TOKEN Worker secret/);
  assert.equal(planAiGatewaySecret(new Set(), true), "rotate");
  assert.equal(planAiGatewaySecret(new Set(["CF_AI_GATEWAY_API_TOKEN"]), false), "reuse");
});

test("requires complete OAuth Worker credentials and reuses remote secrets", () => {
  const required = ["CLIENT_ID", "CLIENT_SECRET"];
  assert.equal(
      planRequiredWorkerSecrets(null, required, new Set(required)),
      "provision",
  );
  assert.equal(
      planRequiredWorkerSecrets(new Set(required), required, new Set()),
      "reuse",
  );
  assert.throws(
      () => planRequiredWorkerSecrets(null, required, new Set(["CLIENT_ID"])),
      /Provide all required Worker secrets together/,
  );
  assert.throws(
      () => planRequiredWorkerSecrets(new Set(["CLIENT_ID"]), required, new Set()),
      /Missing required Worker secrets: CLIENT_SECRET/,
  );
});

test("creates an internal core topology with one public custom domain", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  assert.deepEqual(instance.names, {
    context: "cinaseek-ai-context",
    scheduler: "cinaseek-ai-scheduler",
    workersAi: "cinaseek-ai-workers-ai",
    cloudflare: "cinaseek-ai-cloudflare",
    confluence: "cinaseek-ai-confluence",
    homeassistant: "cinaseek-ai-homeassistant",
    linear: "cinaseek-ai-linear",
    notion: "cinaseek-ai-notion",
    supabase: "cinaseek-ai-supabase",
    slack: "cinaseek-ai-slack",
    mcp: "cinaseek-ai-mcp",
    github: "cinaseek-ai-github",
    google: "cinaseek-ai-google",
    email: "cinaseek-ai-email",
    backend: "cinaseek-ai-backend",
    router: "cinaseek-ai-router",
  });

  for (const [name, config] of Object.entries(instance.configs)) {
    assert.equal(config.workers_dev, false, name);
    assert.equal(config.preview_urls, false, name);
    if (config.build) {
      assert.match(config.build.command, /capnweb-validate\/dist\/cli\.cjs/);
      assert.doesNotMatch(config.build.command, /pnpm/);
    }
  }
  assert.equal(instance.configs["gatekeeper-context"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-scheduler"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-workers-ai"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-cloudflare"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-confluence"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-homeassistant"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-linear"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-notion"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-supabase"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-slack"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-mcp"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-github"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-google"].routes, undefined);
  assert.equal(instance.configs["gatekeeper-email"].routes, undefined);
  assert.equal(instance.configs["workshop-backend"].routes, undefined);
  assert.deepEqual(instance.configs.router.routes, [
    { pattern: "cinaseek.ai", custom_domain: true },
  ]);

  assert.deepEqual(
      instance.configs.router.services.map(({ binding, service }) => [binding, service]),
      [
        ["WORKSHOP_BACKEND", "cinaseek-ai-backend"],
        ["GATEKEEPER_CONTEXT", "cinaseek-ai-context"],
        ["GATEKEEPER_SCHEDULER", "cinaseek-ai-scheduler"],
        ["GATEKEEPER_WORKERS_AI", "cinaseek-ai-workers-ai"],
        ["GATEKEEPER_CLOUDFLARE", "cinaseek-ai-cloudflare"],
        ["GATEKEEPER_CONFLUENCE", "cinaseek-ai-confluence"],
        ["GATEKEEPER_HOMEASSISTANT", "cinaseek-ai-homeassistant"],
        ["GATEKEEPER_LINEAR", "cinaseek-ai-linear"],
        ["GATEKEEPER_NOTION", "cinaseek-ai-notion"],
        ["GATEKEEPER_SUPABASE", "cinaseek-ai-supabase"],
        ["GATEKEEPER_SLACK", "cinaseek-ai-slack"],
        ["GATEKEEPER_MCP", "cinaseek-ai-mcp"],
        ["GATEKEEPER_GITHUB", "cinaseek-ai-github"],
        ["GATEKEEPER_GOOGLE", "cinaseek-ai-google"],
        ["GATEKEEPER_EMAIL", "cinaseek-ai-email"],
      ],
  );
  assert.deepEqual(
      instance.configs["workshop-backend"].services.map(({ binding, service }) => [
        binding,
        service,
      ]),
      [
        ["GATEKEEPER_CONTEXT", "cinaseek-ai-context"],
        ["GATEKEEPER_SCHEDULER", "cinaseek-ai-scheduler"],
        ["GATEKEEPER_WORKERS_AI", "cinaseek-ai-workers-ai"],
        ["GATEKEEPER_CLOUDFLARE", "cinaseek-ai-cloudflare"],
        ["GATEKEEPER_CONFLUENCE", "cinaseek-ai-confluence"],
        ["GATEKEEPER_HOMEASSISTANT", "cinaseek-ai-homeassistant"],
        ["GATEKEEPER_LINEAR", "cinaseek-ai-linear"],
        ["GATEKEEPER_NOTION", "cinaseek-ai-notion"],
        ["GATEKEEPER_SUPABASE", "cinaseek-ai-supabase"],
        ["GATEKEEPER_SLACK", "cinaseek-ai-slack"],
        ["GATEKEEPER_MCP", "cinaseek-ai-mcp"],
        ["GATEKEEPER_GITHUB", "cinaseek-ai-github"],
        ["GATEKEEPER_GOOGLE", "cinaseek-ai-google"],
        ["GATEKEEPER_EMAIL", "cinaseek-ai-email"],
      ],
  );
  assert.equal(
      instance.configs["gatekeeper-workers-ai"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/workers-ai",
  );
  assert.equal(
      instance.configs["gatekeeper-cloudflare"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/cloudflare",
  );
  assert.equal(
      instance.configs["gatekeeper-confluence"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/confluence",
  );
  assert.equal(
      instance.configs["gatekeeper-homeassistant"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/homeassistant",
  );
  assert.equal(
      instance.configs["gatekeeper-linear"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/linear",
  );
  assert.equal(
      instance.configs["gatekeeper-notion"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/notion",
  );
  assert.equal(
      instance.configs["gatekeeper-supabase"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/supabase",
  );
  assert.equal(
      instance.configs["gatekeeper-slack"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/slack",
  );
  assert.equal(
      instance.configs["gatekeeper-mcp"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/mcp",
  );
  assert.equal(
      instance.configs["gatekeeper-github"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/github",
  );
  assert.equal(
      instance.configs["gatekeeper-google"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/google",
  );
  assert.equal(
      instance.configs["gatekeeper-email"].vars.BASE_URL,
      "https://cinaseek.ai/gatekeeper/email",
  );
  assert.equal(instance.configs["gatekeeper-email"].vars.EMAIL_DOMAIN, "mail.cinaseek.ai");
  assert.equal(instance.configs["workshop-backend"].vars.ADMINS, undefined);
  assert.equal(instance.configs["workshop-backend"].vars.CF_ACCESS_ISS, "");
  assert.equal(instance.configs["workshop-backend"].vars.CF_ACCESS_AUD, "");
  assert.equal(instance.configs["workshop-backend"].vars.CF_AI_GATEWAY, "");
  assert.equal(instance.configs["workshop-backend"].vars.CF_AI_GATEWAY_ACCOUNT_ID, "");
  assert.equal(instance.configs["workshop-backend"].vars.CF_AI_GATEWAY_PROVIDERS, "");
  assert.equal(instance.configs["workshop-backend"].vars.CF_AI_GATEWAY_WAI, "");
  assert.equal(instance.configs["workshop-backend"].vars.CF_AI_GATEWAY_WAI_DIRECT, "");
  assert.equal(instance.accessEnabled, false);
  assert.equal(instance.aiGatewayEnabled, false);
  assert.equal(
      instance.configs["workshop-backend"].vars.PUBLIC_BASE_URL,
      "https://cinaseek.ai",
  );
  assert.deepEqual(instance.configs["workshop-backend"].ai, { binding: "WORKERS_AI" });

  for (const binding of instance.configs["workshop-backend"].kv_namespaces) {
    assert.equal(binding.preview_id, undefined);
  }
  assert.deepEqual(instance.configs["workshop-backend"].r2_buckets, [
    { binding: "BLUEPRINT_CONTENT" },
    { binding: "WORKSPACE_BLOBS" },
  ]);
  assert.equal(instance.configs["workshop-backend"].flagship, undefined);
});

test("binds a production Flagship app when explicitly requested", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    flagshipAppId: "ab7716ce-3292-45ec-b654-e739e7815396",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  assert.deepEqual(instance.configs["workshop-backend"].flagship, [{
    binding: "FLAGS",
    app_id: "ab7716ce-3292-45ec-b654-e739e7815396",
  }]);
});

test("preserves an account-local Flagship binding across later deployments", () => {
  const config = { kv_namespaces: [], r2_buckets: [] };
  preserveProvisionedResources(config, {
    flagship: [{
      binding: "FLAGS",
      app_id: "ab7716ce-3292-45ec-b654-e739e7815396",
    }],
  });

  assert.deepEqual(config.flagship, [{
    binding: "FLAGS",
    app_id: "ab7716ce-3292-45ec-b654-e739e7815396",
  }]);
});

test("preserves an account-local Pipeline binding across later deployments", () => {
  const config = { kv_namespaces: [], r2_buckets: [] };
  preserveProvisionedResources(config, {
    pipelines: [{
      binding: "PRODUCT_ANALYTICS",
      stream: "9dcf8722a58e453fb25e98efb2adef63",
    }],
  });

  assert.deepEqual(config.pipelines, [{
    binding: "PRODUCT_ANALYTICS",
    stream: "9dcf8722a58e453fb25e98efb2adef63",
  }]);
});

test("binds Product Analytics when a Pipeline Stream is explicitly requested", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    productAnalyticsStreamId: "9DCF8722A58E453FB25E98EFB2ADEF63",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  assert.deepEqual(instance.configs["workshop-backend"].pipelines, [{
    binding: "PRODUCT_ANALYTICS",
    stream: "9dcf8722a58e453fb25e98efb2adef63",
  }]);
});

test("adds an administrator only when explicitly requested", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    admin: "owner",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });
  assert.deepEqual(instance.configs["workshop-backend"].vars.ADMINS, ["owner"]);
});

test("uses a zone route when the hostname already has DNS records", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    zoneRoute: true,
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  assert.deepEqual(instance.configs.router.routes, [
    { pattern: "cinaseek.ai/*", zone_name: "cinaseek.ai" },
  ]);
});

test("enables verified Cloudflare Access authentication only with a complete pair", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    accessIssuer: "https://cinagroup.cloudflareaccess.com",
    accessAudience: "audience-tag",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  assert.equal(instance.accessEnabled, true);
  assert.equal(
      instance.configs["workshop-backend"].vars.CF_ACCESS_ISS,
      "https://cinagroup.cloudflareaccess.com",
  );
  assert.equal(
      instance.configs["workshop-backend"].vars.CF_ACCESS_AUD,
      "audience-tag",
  );

  assert.throws(() => createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    accessIssuer: "https://cinagroup.cloudflareaccess.com",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  }), /must be provided together/);
});

test("adds AI Gateway vars without serializing the API token", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    aiGateway: "cinaseek",
    aiGatewayAccountId: "7ea8e46d8210bad342fa7595f7935fea",
    aiGatewayProviders: "openai,anthropic,google,cloudflare,openai-compatible",
    workersAiGateway: "cinaseek-workers-ai",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  const vars = instance.configs["workshop-backend"].vars;
  assert.equal(instance.aiGatewayEnabled, true);
  assert.equal(vars.CF_AI_GATEWAY, "cinaseek");
  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, "7ea8e46d8210bad342fa7595f7935fea");
  assert.equal(
      vars.CF_AI_GATEWAY_PROVIDERS,
      "openai,anthropic,google,cloudflare,openai-compatible",
  );
  assert.equal(vars.CF_AI_GATEWAY_WAI, "cinaseek-workers-ai");
  assert.equal(vars.CF_AI_GATEWAY_WAI_DIRECT, "");
  assert.equal(vars.CF_AI_GATEWAY_API_TOKEN, undefined);
});
