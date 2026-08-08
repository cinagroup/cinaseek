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
  parseArgs,
  planAiGatewaySecret,
} from "./deploy-cloudflare.mjs";

const ROOT = resolve(import.meta.dirname, "..");

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
  assert.throws(() => normalizeAccessAudience("two values"),
      /invalid Cloudflare Access audience/);
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

test("creates an internal core topology with one public custom domain", () => {
  const instance = createInstanceConfigs({
    root: ROOT,
    domain: "cinaseek.ai",
    stateDir: join(ROOT, ".wrangler", "test-config-does-not-exist"),
  });

  assert.deepEqual(instance.names, {
    context: "cinaseek-ai-context",
    scheduler: "cinaseek-ai-scheduler",
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
      ],
  );
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
  ]);
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
