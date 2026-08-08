import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";

import {
  createInstanceConfigs,
  instanceSlug,
  normalizeDomain,
} from "./deploy-cloudflare.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("normalizes and validates deployment domains", () => {
  assert.equal(normalizeDomain("CinaSeek.AI."), "cinaseek.ai");
  assert.equal(instanceSlug("cinaseek.ai"), "cinaseek-ai");
  assert.throws(() => normalizeDomain("https://cinaseek.ai"), /invalid domain/);
  assert.throws(() => normalizeDomain("localhost"), /invalid domain/);
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
