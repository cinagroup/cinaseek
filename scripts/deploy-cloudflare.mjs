#!/usr/bin/env node

// Deploys one self-contained CinaSeek instance without the external deployment service used by
// the release-manifest pipeline. Account-specific Wrangler configs and auto-provisioned resource
// IDs live under .wrangler/ (gitignored); no credentials are written by this script.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CLI = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const TYPESCRIPT_CLI = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const VITE_CLI = join(ROOT, "node_modules", "vite", "bin", "vite.js");

const CORE_PACKAGES = [
  "gatekeeper-context",
  "gatekeeper-scheduler",
  "workshop-backend",
  "router",
];

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

export function normalizeDomain(value) {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || !domain.includes(".")) {
    throw new Error(`invalid domain: ${value}`);
  }
  for (const label of domain.split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error(`invalid domain: ${value}`);
    }
  }
  return domain;
}

export function instanceSlug(domain) {
  return normalizeDomain(domain).replaceAll(".", "-");
}

function readJsonc(path) {
  return parse(readFileSync(path, "utf8"));
}

function previousConfig(path) {
  return existsSync(path) ? readJsonc(path) : {};
}

function preserveProvisionedResources(config, previous) {
  const previousKv = new Map(
      (previous.kv_namespaces ?? []).map((binding) => [binding.binding, binding]));
  config.kv_namespaces = (config.kv_namespaces ?? []).map(({ binding }) => ({
    binding,
    ...(previousKv.get(binding)?.id ? { id: previousKv.get(binding).id } : {}),
  }));

  const previousR2 = new Map(
      (previous.r2_buckets ?? []).map((binding) => [binding.binding, binding]));
  config.r2_buckets = (config.r2_buckets ?? []).map(({ binding }) => ({
    binding,
    ...(previousR2.get(binding)?.bucket_name
      ? { bucket_name: previousR2.get(binding).bucket_name }
      : {}),
  }));
}

function baseProductionConfig(root, packageName, workerName, previous) {
  const packageDir = join(root, "packages", packageName);
  const config = readJsonc(join(packageDir, "wrangler.jsonc"));

  config.$schema = portablePath(join(root, "node_modules", "wrangler", "config-schema.json"));
  config.name = workerName;
  config.main = portablePath(resolve(packageDir, config.main));
  config.workers_dev = false;
  config.preview_urls = false;
  delete config.route;
  delete config.routes;

  if (config.build) {
    const capnwebValidateCli = join(
        packageDir,
        "node_modules",
        "capnweb-validate",
        "dist",
        "cli.cjs",
    );
    config.build = {
      ...config.build,
      command: `"${portablePath(process.execPath)}" ` +
        `"${portablePath(capnwebValidateCli)}" build --out .wrangler/validate`,
      cwd: portablePath(packageDir),
    };
    delete config.build.watch_dir;
  }

  preserveProvisionedResources(config, previous);
  return config;
}

export function createInstanceConfigs({
  root = ROOT,
  domain: domainInput,
  admin,
  zoneRoute = false,
  stateDir: stateDirInput,
} = {}) {
  const domain = normalizeDomain(domainInput);
  const slug = instanceSlug(domain);
  const publicBaseUrl = `https://${domain}`;
  const stateDir = stateDirInput ?? join(root, ".wrangler", "production", slug);
  const configPaths = Object.fromEntries(
      CORE_PACKAGES.map((name) => [name, join(stateDir, `${name}.jsonc`)]));
  const names = {
    context: `${slug}-context`,
    scheduler: `${slug}-scheduler`,
    backend: `${slug}-backend`,
    router: `${slug}-router`,
  };

  const context = baseProductionConfig(
      root,
      "gatekeeper-context",
      names.context,
      previousConfig(configPaths["gatekeeper-context"]),
  );
  context.vars = { ...context.vars, BASE_URL: `${publicBaseUrl}/gatekeeper/context` };

  const scheduler = baseProductionConfig(
      root,
      "gatekeeper-scheduler",
      names.scheduler,
      previousConfig(configPaths["gatekeeper-scheduler"]),
  );
  scheduler.vars = { ...scheduler.vars, BASE_URL: `${publicBaseUrl}/gatekeeper/scheduler` };

  const backend = baseProductionConfig(
      root,
      "workshop-backend",
      names.backend,
      previousConfig(configPaths["workshop-backend"]),
  );
  backend.vars = {
    ...backend.vars,
    PUBLIC_BASE_URL: publicBaseUrl,
    ...(admin ? { ADMINS: [admin] } : {}),
  };
  backend.ai = { binding: "WORKERS_AI" };
  backend.services = [
    {
      binding: "GATEKEEPER_CONTEXT",
      service: names.context,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: publicBaseUrl },
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: names.scheduler,
      entrypoint: "GatekeeperVendor",
    },
  ];

  const router = baseProductionConfig(
      root,
      "router",
      names.router,
      previousConfig(configPaths.router),
  );
  router.services = [
    { binding: "WORKSHOP_BACKEND", service: names.backend },
    { binding: "GATEKEEPER_CONTEXT", service: names.context },
    { binding: "GATEKEEPER_SCHEDULER", service: names.scheduler },
  ];
  router.assets = {
    ...router.assets,
    directory: portablePath(join(root, "packages", "workshop-frontend", "dist")),
  };
  router.routes = zoneRoute
    ? [{ pattern: `${domain}/*`, zone_name: domain }]
    : [{ pattern: domain, custom_domain: true }];

  return {
    domain,
    publicBaseUrl,
    slug,
    stateDir,
    names,
    configPaths,
    configs: {
      "gatekeeper-context": context,
      "gatekeeper-scheduler": scheduler,
      "workshop-backend": backend,
      router,
    },
  };
}

export function writeInstanceConfigs(instance) {
  mkdirSync(instance.stateDir, { recursive: true });
  for (const packageName of CORE_PACKAGES) {
    writeFileSync(
        instance.configPaths[packageName],
        JSON.stringify(instance.configs[packageName], null, 2) + "\n",
    );
  }
}

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

function runWrangler(args) {
  run(process.execPath, [WRANGLER_CLI, ...args]);
}

function parseArgs(argv) {
  const args = { domain: undefined, admin: undefined, dryRun: false, zoneRoute: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domain") args.domain = argv[++i];
    else if (argv[i] === "--admin") args.admin = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--zone-route") args.zoneRoute = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.domain) throw new Error("--domain <hostname> is required");
  if (args.admin !== undefined && !args.admin.trim()) {
    throw new Error("--admin must not be empty");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const instance = createInstanceConfigs({
    domain: args.domain,
    admin: args.admin?.trim(),
    zoneRoute: args.zoneRoute,
  });
  writeInstanceConfigs(instance);

  // These two Gatekeepers embed single-file UIs generated outside their Wrangler custom builds.
  const contextDir = join(ROOT, "packages", "gatekeeper-context");
  const schedulerDir = join(ROOT, "packages", "gatekeeper-scheduler");
  const frontendDir = join(ROOT, "packages", "workshop-frontend");
  const backendDir = join(ROOT, "packages", "workshop-backend");
  run(process.execPath, [join(contextDir, "build-app.mjs")], { cwd: contextDir });
  run(process.execPath, [join(schedulerDir, "build-app.mjs")], { cwd: schedulerDir });
  run(process.execPath, [join(backendDir, "build-browser-runtime.mjs")], { cwd: backendDir });
  run(process.execPath, [join(backendDir, "scripts", "build-format-blueprints.mjs")], {
    cwd: backendDir,
  });

  // Password authentication is the safe standalone default when Cloudflare Access is not
  // configured. Set the build-time flag explicitly so an inherited shell value cannot change it.
  run(process.execPath, [TYPESCRIPT_CLI], { cwd: frontendDir });
  run(process.execPath, [VITE_CLI, "build"], {
    cwd: frontendDir,
    env: { ...process.env, VITE_CF_ACCESS_MODE: "false" },
  });

  if (!args.dryRun) runWrangler(["whoami"]);

  for (const packageName of CORE_PACKAGES) {
    const deployArgs = [
      "deploy",
      "--config",
      instance.configPaths[packageName],
      "--keep-vars",
    ];
    if (args.dryRun) deployArgs.push("--dry-run");
    runWrangler(deployArgs);
  }

  console.log(args.dryRun
    ? `\nCloudflare dry-run passed for ${instance.publicBaseUrl}.`
    : `\nCinaSeek deployed to ${instance.publicBaseUrl}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
