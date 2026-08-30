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
const VITE_PLUS_CLI = join(ROOT, "node_modules", "vite-plus", "bin", "vp");

const CORE_PACKAGES = [
  "gatekeeper-context",
  "gatekeeper-scheduler",
  "gatekeeper-workers-ai",
  "workshop-backend",
  "router",
];

const AI_GATEWAY_SECRET_NAME = "CF_AI_GATEWAY_API_TOKEN";
const AI_GATEWAY_TOKEN_INPUT_ENV = "CINASEEK_AI_GATEWAY_API_TOKEN";
const ACCESS_PREFLIGHT_TIMEOUT_MS = 15_000;
const AI_GATEWAY_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-compatible",
  "google",
  "cloudflare",
]);

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

export function normalizeAccessIssuer(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`invalid Cloudflare Access issuer: ${value}`);
  }
  const isTeamDomain = url.hostname.endsWith(".cloudflareaccess.com");
  if (url.protocol !== "https:" || !isTeamDomain || url.port || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`invalid Cloudflare Access issuer: ${value}`);
  }
  return url.origin;
}

export function normalizeAccessAudience(value) {
  const audience = value.trim();
  if (!audience || audience.length > 64 || /\s/.test(audience)) {
    throw new Error("invalid Cloudflare Access audience");
  }
  return audience;
}

export async function verifyAccessEdge({ domain, issuer, fetchImpl = fetch }) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedIssuer = normalizeAccessIssuer(issuer);

  // The origin page is intentionally public. These are the two authentication chokepoints that
  // must remain protected before either an RPC connection or post-login redirect reaches origin.
  for (const path of ["/auth/login", "/api"]) {
    let challenge;
    try {
      challenge = await fetchImpl(`https://${normalizedDomain}${path}`, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(ACCESS_PREFLIGHT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Cloudflare Access preflight could not reach ${normalizedDomain}${path}`, {
        cause: error,
      });
    }

    if (![301, 302, 303, 307, 308].includes(challenge.status)) {
      throw new Error(
          `Cloudflare Access is not challenging ${normalizedDomain}${path} ` +
          `(HTTP ${challenge.status})`);
    }
    const location = challenge.headers.get("location");
    if (!location) {
      throw new Error(`Cloudflare Access challenge for ${normalizedDomain}${path} has no redirect`);
    }

    let loginUrl;
    try {
      loginUrl = new URL(location, `https://${normalizedDomain}`);
    } catch {
      throw new Error(
          `Cloudflare Access challenge for ${normalizedDomain}${path} has an invalid redirect`);
    }
    if (loginUrl.origin !== normalizedIssuer ||
        !loginUrl.pathname.startsWith("/cdn-cgi/access/login/")) {
      throw new Error(
          `Cloudflare Access challenge for ${normalizedDomain}${path} ` +
          `does not use ${normalizedIssuer}`);
    }
  }

  let certs;
  try {
    certs = await fetchImpl(`${normalizedIssuer}/cdn-cgi/access/certs`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ACCESS_PREFLIGHT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Cloudflare Access signing keys are unavailable for ${normalizedIssuer}`, {
      cause: error,
    });
  }
  if (!certs.ok) {
    throw new Error(
        `Cloudflare Access signing keys returned HTTP ${certs.status} for ${normalizedIssuer}`);
  }

  let jwks;
  try {
    jwks = await certs.json();
  } catch {
    throw new Error(`Cloudflare Access signing keys are not valid JSON for ${normalizedIssuer}`);
  }
  const keys = jwks && typeof jwks === "object" && Array.isArray(jwks.keys) ? jwks.keys : [];
  if (!keys.some((key) => key && typeof key === "object" &&
      key.kty === "RSA" && key.alg === "RS256")) {
    throw new Error(`Cloudflare Access has no RS256 signing key for ${normalizedIssuer}`);
  }
}

function normalizeAiGatewayName(value, optionName) {
  const name = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`${optionName} must be 1-64 letters, digits, hyphens, or underscores`);
  }
  return name;
}

export function normalizeAiGatewayOptions({
  gateway,
  accountId,
  providers,
  workersAiGateway,
  workersAiDirect = false,
} = {}) {
  const configured = gateway !== undefined || accountId !== undefined || providers !== undefined ||
      workersAiGateway !== undefined || workersAiDirect;
  if (!configured) return undefined;
  if (gateway === undefined || accountId === undefined || providers === undefined) {
    throw new Error(
        "--ai-gateway, --ai-gateway-account-id, and --ai-gateway-providers are required together");
  }
  if (workersAiGateway !== undefined && workersAiDirect) {
    throw new Error("--workers-ai-gateway and --workers-ai-direct cannot be used together");
  }

  const normalizedAccountId = accountId.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalizedAccountId)) {
    throw new Error("--ai-gateway-account-id must be a 32-character Cloudflare account ID");
  }

  const providerList = [...new Set(
      (Array.isArray(providers) ? providers : providers.split(","))
          .map((provider) => provider.trim().toLowerCase())
          .filter(Boolean),
  )];
  if (providerList.length === 0) {
    throw new Error("--ai-gateway-providers must include at least one provider");
  }
  const invalidProvider = providerList.find((provider) => !AI_GATEWAY_PROVIDERS.has(provider));
  if (invalidProvider) {
    throw new Error(
        `unsupported AI Gateway provider: ${invalidProvider}; expected one of ` +
        [...AI_GATEWAY_PROVIDERS].join(", "));
  }

  return {
    gateway: normalizeAiGatewayName(gateway, "--ai-gateway"),
    accountId: normalizedAccountId,
    providers: providerList,
    workersAiGateway: workersAiGateway === undefined
      ? undefined
      : normalizeAiGatewayName(workersAiGateway, "--workers-ai-gateway"),
    workersAiDirect: Boolean(workersAiDirect),
  };
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
  accessIssuer,
  accessAudience,
  aiGateway,
  aiGatewayAccountId,
  aiGatewayProviders,
  workersAiGateway,
  workersAiDirect = false,
  zoneRoute = false,
  stateDir: stateDirInput,
} = {}) {
  const domain = normalizeDomain(domainInput);
  const hasAccessIssuer = accessIssuer !== undefined;
  const hasAccessAudience = accessAudience !== undefined;
  if (hasAccessIssuer !== hasAccessAudience) {
    throw new Error("--access-issuer and --access-audience must be provided together");
  }
  const access = hasAccessIssuer
    ? {
        issuer: normalizeAccessIssuer(accessIssuer),
        audience: normalizeAccessAudience(accessAudience),
      }
    : undefined;
  const gateway = normalizeAiGatewayOptions({
    gateway: aiGateway,
    accountId: aiGatewayAccountId,
    providers: aiGatewayProviders,
    workersAiGateway,
    workersAiDirect,
  });
  const slug = instanceSlug(domain);
  const publicBaseUrl = `https://${domain}`;
  const stateDir = stateDirInput ?? join(root, ".wrangler", "production", slug);
  const configPaths = Object.fromEntries(
      CORE_PACKAGES.map((name) => [name, join(stateDir, `${name}.jsonc`)]));
  const names = {
    context: `${slug}-context`,
    scheduler: `${slug}-scheduler`,
    workersAi: `${slug}-workers-ai`,
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

  const workersAi = baseProductionConfig(
      root,
      "gatekeeper-workers-ai",
      names.workersAi,
      previousConfig(configPaths["gatekeeper-workers-ai"]),
  );
  workersAi.vars = {
    ...workersAi.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/workers-ai`,
  };

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
    // These mode vars are always emitted because deploy uses --keep-vars for unrelated,
    // externally managed settings. Empty values explicitly clear a previous deployment's mode.
    CF_ACCESS_ISS: access?.issuer ?? "",
    CF_ACCESS_AUD: access?.audience ?? "",
    CF_AI_GATEWAY: gateway?.gateway ?? "",
    CF_AI_GATEWAY_ACCOUNT_ID: gateway?.accountId ?? "",
    CF_AI_GATEWAY_PROVIDERS: gateway?.providers.join(",") ?? "",
    CF_AI_GATEWAY_WAI: gateway?.workersAiGateway ?? "",
    CF_AI_GATEWAY_WAI_DIRECT: gateway?.workersAiDirect ? "true" : "",
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
    {
      binding: "GATEKEEPER_WORKERS_AI",
      service: names.workersAi,
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
    { binding: "GATEKEEPER_WORKERS_AI", service: names.workersAi },
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
    accessEnabled: Boolean(access),
    aiGatewayEnabled: Boolean(gateway),
    slug,
    stateDir,
    names,
    configPaths,
    configs: {
      "gatekeeper-context": context,
      "gatekeeper-scheduler": scheduler,
      "gatekeeper-workers-ai": workersAi,
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

function readRemoteSecretNames(configPath) {
  try {
    const output = execFileSync(
        process.execPath,
        [WRANGLER_CLI, "secret", "list", "--config", configPath],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const secrets = JSON.parse(output);
    return new Set(secrets.map((secret) => secret.name));
  } catch {
    return null;
  }
}

export function planAiGatewaySecret(remoteSecrets, tokenProvided) {
  if (remoteSecrets === null) {
    throw new Error(
        `Unable to verify the remote ${AI_GATEWAY_SECRET_NAME} Worker secret. ` +
        "Deploy the Worker once without AI Gateway mode (if it does not exist yet), then retry. " +
        "No Gateway-enabled version was uploaded.");
  }
  if (tokenProvided) return "rotate";
  if (!remoteSecrets.has(AI_GATEWAY_SECRET_NAME)) {
    throw new Error(
        `AI Gateway mode requires the ${AI_GATEWAY_SECRET_NAME} Worker secret. Set ` +
        `${AI_GATEWAY_TOKEN_INPUT_ENV} in the deployment environment or provision the secret ` +
        "with Wrangler before deploying.");
  }
  return "reuse";
}

function putRemoteSecret(configPath, name, value) {
  console.log(`\n> wrangler secret put ${name} --config ${configPath} (value via stdin)`);
  execFileSync(
      process.execPath,
      [WRANGLER_CLI, "secret", "put", name, "--config", configPath],
      { cwd: ROOT, input: `${value}\n`, stdio: ["pipe", "inherit", "inherit"] },
  );
}

export function parseArgs(argv) {
  const args = {
    domain: undefined,
    admin: undefined,
    accessIssuer: undefined,
    accessAudience: undefined,
    aiGateway: undefined,
    aiGatewayAccountId: undefined,
    aiGatewayProviders: undefined,
    workersAiGateway: undefined,
    workersAiDirect: false,
    dryRun: false,
    zoneRoute: false,
  };
  const readValue = (option, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domain") args.domain = readValue(argv[i], i++);
    else if (argv[i] === "--admin") args.admin = readValue(argv[i], i++);
    else if (argv[i] === "--access-issuer") args.accessIssuer = readValue(argv[i], i++);
    else if (argv[i] === "--access-audience") args.accessAudience = readValue(argv[i], i++);
    else if (argv[i] === "--ai-gateway") args.aiGateway = readValue(argv[i], i++);
    else if (argv[i] === "--ai-gateway-account-id") {
      args.aiGatewayAccountId = readValue(argv[i], i++);
    } else if (argv[i] === "--ai-gateway-providers") {
      args.aiGatewayProviders = readValue(argv[i], i++);
    } else if (argv[i] === "--workers-ai-gateway") {
      args.workersAiGateway = readValue(argv[i], i++);
    }
    else if (argv[i] === "--workers-ai-direct") args.workersAiDirect = true;
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
  // Consume the deployment-only secret before launching build subprocesses. It is never written to
  // generated Wrangler config and is passed only to `wrangler secret put` over stdin.
  const aiGatewayToken = process.env[AI_GATEWAY_TOKEN_INPUT_ENV]?.trim();
  delete process.env[AI_GATEWAY_TOKEN_INPUT_ENV];
  const instance = createInstanceConfigs({
    domain: args.domain,
    admin: args.admin?.trim(),
    accessIssuer: args.accessIssuer,
    accessAudience: args.accessAudience,
    aiGateway: args.aiGateway,
    aiGatewayAccountId: args.aiGatewayAccountId,
    aiGatewayProviders: args.aiGatewayProviders,
    workersAiGateway: args.workersAiGateway,
    workersAiDirect: args.workersAiDirect,
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
  run(process.execPath, [
    VITE_PLUS_CLI,
    "run",
    "-F",
    "@gadgets/workers-ai-gatekeeper",
    "--no-cache",
    "build:configurator",
  ]);
  run(process.execPath, [join(backendDir, "build-browser-runtime.mjs")], { cwd: backendDir });
  run(process.execPath, [join(backendDir, "scripts", "build-connector-blueprints.mjs")], {
    cwd: backendDir,
  });
  run(process.execPath, [join(backendDir, "scripts", "validate-connector-blueprints.mjs")], {
    cwd: backendDir,
  });
  run(process.execPath, [join(backendDir, "scripts", "build-format-blueprints.mjs")], {
    cwd: backendDir,
  });

  // Select authentication mode explicitly so an inherited shell value cannot change the build.
  // Access must already protect the authentication chokepoints before an Access-mode build is
  // deployed. The root page may still be whole-host protected during the first staged rollout.
  run(process.execPath, [TYPESCRIPT_CLI], { cwd: frontendDir });
  run(process.execPath, [VITE_CLI, "build"], {
    cwd: frontendDir,
    env: { ...process.env, VITE_CF_ACCESS_MODE: String(instance.accessEnabled) },
  });

  if (!args.dryRun) {
    runWrangler(["whoami"]);
    if (instance.accessEnabled) {
      await verifyAccessEdge({
        domain: instance.domain,
        issuer: instance.configs["workshop-backend"].vars.CF_ACCESS_ISS,
      });
      console.log(`\nCloudflare Access preflight passed for ${instance.publicBaseUrl}.`);
    }
  }

  const backendConfigPath = instance.configPaths["workshop-backend"];
  if (!args.dryRun && instance.aiGatewayEnabled) {
    const remoteSecrets = readRemoteSecretNames(backendConfigPath);
    const secretAction = planAiGatewaySecret(remoteSecrets, Boolean(aiGatewayToken));
    if (secretAction === "rotate") {
      // Rotate before uploading the Gateway-enabled version so no live version lacks its secret.
      putRemoteSecret(backendConfigPath, AI_GATEWAY_SECRET_NAME, aiGatewayToken);
    }
  } else if (aiGatewayToken && !instance.aiGatewayEnabled) {
    throw new Error(`${AI_GATEWAY_TOKEN_INPUT_ENV} was provided without --ai-gateway configuration.`);
  }

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
