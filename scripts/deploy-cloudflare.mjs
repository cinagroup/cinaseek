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
const VALIDATED_WORKER_BUILD = join(ROOT, "scripts", "build-validated-worker.mjs");

const CORE_PACKAGES = [
  "gatekeeper-context",
  "gatekeeper-scheduler",
  "gatekeeper-workers-ai",
  "gatekeeper-cloudflare",
  "gatekeeper-confluence",
  "gatekeeper-homeassistant",
  "gatekeeper-linear",
  "gatekeeper-notion",
  "gatekeeper-supabase",
  "gatekeeper-slack",
  "gatekeeper-mcp",
  "gatekeeper-github",
  "gatekeeper-google",
  "gatekeeper-email",
  "workshop-backend",
  "router",
];

const AI_GATEWAY_SECRET_NAME = "CF_AI_GATEWAY_API_TOKEN";
const AI_GATEWAY_TOKEN_INPUT_ENV = "CINASEEK_AI_GATEWAY_API_TOKEN";
const GITHUB_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_GITHUB_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_GITHUB_CLIENT_SECRET"],
];
const GOOGLE_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_GOOGLE_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_GOOGLE_CLIENT_SECRET"],
];
const CLOUDFLARE_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_CLOUDFLARE_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_CLOUDFLARE_CLIENT_SECRET"],
];
const CONFLUENCE_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_CONFLUENCE_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_CONFLUENCE_CLIENT_SECRET"],
];
const LINEAR_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_LINEAR_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_LINEAR_CLIENT_SECRET"],
];
const NOTION_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_NOTION_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_NOTION_CLIENT_SECRET"],
];
const SUPABASE_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_SUPABASE_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_SUPABASE_CLIENT_SECRET"],
];
const SLACK_SECRET_INPUTS = [
  ["CLIENT_ID", "CINASEEK_SLACK_CLIENT_ID"],
  ["CLIENT_SECRET", "CINASEEK_SLACK_CLIENT_SECRET"],
];
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

export function normalizeFlagshipAppId(value) {
  const appId = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(appId)) {
    throw new Error("--flagship-app-id must be a Cloudflare Flagship app UUID");
  }
  return appId;
}

export function normalizePipelineStreamId(value) {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("--product-analytics-stream-id must be a 32-character Pipeline Stream ID");
  }
  return normalized;
}

function normalizeDailyLlmCallLimit(value) {
  const normalized = String(value).trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--daily-llm-call-limit must be a positive integer");
  }
  return String(parsed);
}

function normalizeMinimumCloudflareBalance(value) {
  const normalized = String(value).trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--minimum-cloudflare-balance must be a non-negative number");
  }
  return String(parsed);
}

function normalizeWorkspaceBlobMode(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!new Set(["disabled", "mirror", "r2"]).has(normalized)) {
    throw new Error("--workspace-blob-mode must be disabled, mirror, or r2");
  }
  return normalized;
}

function normalizePositiveInteger(value, option, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = String(value).trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0 ||
      parsed > maximum) {
    const suffix = maximum === Number.MAX_SAFE_INTEGER ? "" : ` no greater than ${maximum}`;
    throw new Error(`${option} must be a positive integer${suffix}`);
  }
  return String(parsed);
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

  // Gatekeepers authenticate their own OAuth callbacks with short-lived state and nonces. Putting
  // Access in front of these paths breaks callbacks opened in a system browser that does not share
  // the application's Access cookie.
  const callbackPath = "/gatekeeper/github/oauth";
  let callback;
  try {
    callback = await fetchImpl(`https://${normalizedDomain}${callbackPath}`, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(ACCESS_PREFLIGHT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
        `Cloudflare Access preflight could not reach ${normalizedDomain}${callbackPath}`, {
          cause: error,
        });
  }
  const callbackLocation = callback.headers.get("location");
  if ([301, 302, 303, 307, 308].includes(callback.status) && callbackLocation) {
    let callbackRedirect;
    try {
      callbackRedirect = new URL(callbackLocation, `https://${normalizedDomain}`);
    } catch {
      callbackRedirect = undefined;
    }
    if (callbackRedirect?.origin === normalizedIssuer &&
        callbackRedirect.pathname.startsWith("/cdn-cgi/access/login/")) {
      throw new Error(
          `Cloudflare Access must not challenge ${normalizedDomain}${callbackPath}`);
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

export function preserveProvisionedResources(config, previous) {
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

  const previousFlagship = new Map(
      (previous.flagship ?? []).map((binding) => [binding.binding, binding]));
  const flagship = config.flagship ?? previous.flagship ?? [];
  if (flagship.length > 0) {
    config.flagship = flagship.map(({ binding, app_id: appId }) => ({
      binding,
      app_id: previousFlagship.get(binding)?.app_id ?? appId,
    }));
  }

  const pipelines = config.pipelines ?? previous.pipelines ?? [];
  if (pipelines.length > 0) {
    config.pipelines = pipelines.map(({ binding, stream }) => ({ binding, stream }));
  }
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
        `"${portablePath(VALIDATED_WORKER_BUILD)}" ` +
        `"${portablePath(capnwebValidateCli)}"`,
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
  clearAdmins = false,
  cloudflareLimitsEnabled,
  dailyLlmCallLimit,
  minimumCloudflareBalance,
  realtimeConsoleEnabled,
  workspaceBlobMode,
  workspaceAttachmentLimitBytes,
  workspaceAttachmentLimitCount,
  accessIssuer,
  accessAudience,
  flagshipAppId,
  productAnalyticsStreamId,
  aiGateway,
  aiGatewayAccountId,
  aiGatewayProviders,
  workersAiGateway,
  workersAiDirect = false,
  zoneRoute = false,
  stateDir: stateDirInput,
} = {}) {
  const domain = normalizeDomain(domainInput);
  if (admin !== undefined && clearAdmins) {
    throw new Error("--admin and --clear-admins cannot be used together");
  }
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
  const flagship = flagshipAppId === undefined
    ? undefined
    : normalizeFlagshipAppId(flagshipAppId);
  const analyticsStream = productAnalyticsStreamId === undefined
    ? undefined
    : normalizePipelineStreamId(productAnalyticsStreamId);
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
    cloudflare: `${slug}-cloudflare`,
    confluence: `${slug}-confluence`,
    homeassistant: `${slug}-homeassistant`,
    linear: `${slug}-linear`,
    notion: `${slug}-notion`,
    supabase: `${slug}-supabase`,
    slack: `${slug}-slack`,
    mcp: `${slug}-mcp`,
    github: `${slug}-github`,
    google: `${slug}-google`,
    email: `${slug}-email`,
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

  const cloudflare = baseProductionConfig(
      root,
      "gatekeeper-cloudflare",
      names.cloudflare,
      previousConfig(configPaths["gatekeeper-cloudflare"]),
  );
  cloudflare.vars = {
    ...cloudflare.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/cloudflare`,
  };

  const confluence = baseProductionConfig(
      root,
      "gatekeeper-confluence",
      names.confluence,
      previousConfig(configPaths["gatekeeper-confluence"]),
  );
  confluence.vars = {
    ...confluence.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/confluence`,
  };

  const homeassistant = baseProductionConfig(
      root,
      "gatekeeper-homeassistant",
      names.homeassistant,
      previousConfig(configPaths["gatekeeper-homeassistant"]),
  );
  homeassistant.vars = {
    ...homeassistant.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/homeassistant`,
  };

  const linear = baseProductionConfig(
      root,
      "gatekeeper-linear",
      names.linear,
      previousConfig(configPaths["gatekeeper-linear"]),
  );
  linear.vars = {
    ...linear.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/linear`,
  };

  const notion = baseProductionConfig(
      root,
      "gatekeeper-notion",
      names.notion,
      previousConfig(configPaths["gatekeeper-notion"]),
  );
  notion.vars = {
    ...notion.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/notion`,
  };

  const supabase = baseProductionConfig(
      root,
      "gatekeeper-supabase",
      names.supabase,
      previousConfig(configPaths["gatekeeper-supabase"]),
  );
  supabase.vars = {
    ...supabase.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/supabase`,
  };

  const slack = baseProductionConfig(
      root,
      "gatekeeper-slack",
      names.slack,
      previousConfig(configPaths["gatekeeper-slack"]),
  );
  slack.vars = {
    ...slack.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/slack`,
  };

  const mcp = baseProductionConfig(
      root,
      "gatekeeper-mcp",
      names.mcp,
      previousConfig(configPaths["gatekeeper-mcp"]),
  );
  mcp.vars = {
    ...mcp.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/mcp`,
  };

  const github = baseProductionConfig(
      root,
      "gatekeeper-github",
      names.github,
      previousConfig(configPaths["gatekeeper-github"]),
  );
  github.vars = {
    ...github.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/github`,
  };

  const google = baseProductionConfig(
      root,
      "gatekeeper-google",
      names.google,
      previousConfig(configPaths["gatekeeper-google"]),
  );
  google.vars = {
    ...google.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/google`,
  };

  const email = baseProductionConfig(
      root,
      "gatekeeper-email",
      names.email,
      previousConfig(configPaths["gatekeeper-email"]),
  );
  email.vars = {
    ...email.vars,
    BASE_URL: `${publicBaseUrl}/gatekeeper/email`,
    EMAIL_DOMAIN: `mail.${domain}`,
  };

  const previousBackend = previousConfig(configPaths["workshop-backend"]);
  const backend = baseProductionConfig(
      root,
      "workshop-backend",
      names.backend,
      previousBackend,
  );
  if (flagship) {
    backend.flagship = [{ binding: "FLAGS", app_id: flagship }];
  }
  if (analyticsStream) {
    backend.pipelines = [{ binding: "PRODUCT_ANALYTICS", stream: analyticsStream }];
  }
  backend.vars = {
    ...backend.vars,
    PUBLIC_BASE_URL: publicBaseUrl,
    ...(admin
      ? { ADMINS: [admin] }
      : clearAdmins || previousBackend.vars?.ADMINS === undefined
        ? {}
        : { ADMINS: previousBackend.vars.ADMINS }),
    ...(cloudflareLimitsEnabled !== undefined
      ? { ENABLE_CLOUDFLARE_LIMITS: cloudflareLimitsEnabled ? "true" : "" }
      : previousBackend.vars?.ENABLE_CLOUDFLARE_LIMITS === undefined
        ? {}
        : { ENABLE_CLOUDFLARE_LIMITS: previousBackend.vars.ENABLE_CLOUDFLARE_LIMITS }),
    ...(dailyLlmCallLimit !== undefined
      ? { DAILY_LLM_CALL_LIMIT: normalizeDailyLlmCallLimit(dailyLlmCallLimit) }
      : previousBackend.vars?.DAILY_LLM_CALL_LIMIT === undefined
        ? {}
        : { DAILY_LLM_CALL_LIMIT: previousBackend.vars.DAILY_LLM_CALL_LIMIT }),
    ...(minimumCloudflareBalance !== undefined
      ? {
          MINIMUM_CLOUDFLARE_BALANCE:
            normalizeMinimumCloudflareBalance(minimumCloudflareBalance),
        }
      : previousBackend.vars?.MINIMUM_CLOUDFLARE_BALANCE === undefined
        ? {}
        : { MINIMUM_CLOUDFLARE_BALANCE: previousBackend.vars.MINIMUM_CLOUDFLARE_BALANCE }),
    ...(realtimeConsoleEnabled !== undefined
      ? { REALTIME_CONSOLE_ENABLED: realtimeConsoleEnabled ? "true" : "" }
      : previousBackend.vars?.REALTIME_CONSOLE_ENABLED === undefined
        ? {}
        : { REALTIME_CONSOLE_ENABLED: previousBackend.vars.REALTIME_CONSOLE_ENABLED }),
    ...(workspaceBlobMode !== undefined
      ? { WORKSPACE_BLOB_MODE: normalizeWorkspaceBlobMode(workspaceBlobMode) }
      : previousBackend.vars?.WORKSPACE_BLOB_MODE === undefined
        ? {}
        : { WORKSPACE_BLOB_MODE: previousBackend.vars.WORKSPACE_BLOB_MODE }),
    ...(workspaceAttachmentLimitBytes !== undefined
      ? {
          WORKSPACE_ATTACHMENT_LIMIT_BYTES: normalizePositiveInteger(
              workspaceAttachmentLimitBytes, "--workspace-attachment-limit-bytes"),
        }
      : previousBackend.vars?.WORKSPACE_ATTACHMENT_LIMIT_BYTES === undefined
        ? {}
        : {
            WORKSPACE_ATTACHMENT_LIMIT_BYTES:
              previousBackend.vars.WORKSPACE_ATTACHMENT_LIMIT_BYTES,
          }),
    ...(workspaceAttachmentLimitCount !== undefined
      ? {
          WORKSPACE_ATTACHMENT_LIMIT_COUNT: normalizePositiveInteger(
              workspaceAttachmentLimitCount, "--workspace-attachment-limit-count", 100_000),
        }
      : previousBackend.vars?.WORKSPACE_ATTACHMENT_LIMIT_COUNT === undefined
        ? {}
        : {
            WORKSPACE_ATTACHMENT_LIMIT_COUNT:
              previousBackend.vars.WORKSPACE_ATTACHMENT_LIMIT_COUNT,
          }),
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
    {
      binding: "GATEKEEPER_CLOUDFLARE",
      service: names.cloudflare,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CONFLUENCE",
      service: names.confluence,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_HOMEASSISTANT",
      service: names.homeassistant,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_LINEAR",
      service: names.linear,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_NOTION",
      service: names.notion,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_SUPABASE",
      service: names.supabase,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_SLACK",
      service: names.slack,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_MCP",
      service: names.mcp,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_GITHUB",
      service: names.github,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_GOOGLE",
      service: names.google,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_EMAIL",
      service: names.email,
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
    { binding: "GATEKEEPER_CLOUDFLARE", service: names.cloudflare },
    { binding: "GATEKEEPER_CONFLUENCE", service: names.confluence },
    { binding: "GATEKEEPER_HOMEASSISTANT", service: names.homeassistant },
    { binding: "GATEKEEPER_LINEAR", service: names.linear },
    { binding: "GATEKEEPER_NOTION", service: names.notion },
    { binding: "GATEKEEPER_SUPABASE", service: names.supabase },
    { binding: "GATEKEEPER_SLACK", service: names.slack },
    { binding: "GATEKEEPER_MCP", service: names.mcp },
    { binding: "GATEKEEPER_GITHUB", service: names.github },
    { binding: "GATEKEEPER_GOOGLE", service: names.google },
    { binding: "GATEKEEPER_EMAIL", service: names.email },
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
      "gatekeeper-cloudflare": cloudflare,
      "gatekeeper-confluence": confluence,
      "gatekeeper-homeassistant": homeassistant,
      "gatekeeper-linear": linear,
      "gatekeeper-notion": notion,
      "gatekeeper-supabase": supabase,
      "gatekeeper-slack": slack,
      "gatekeeper-mcp": mcp,
      "gatekeeper-github": github,
      "gatekeeper-google": google,
      "gatekeeper-email": email,
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

export function planRequiredWorkerSecrets(remoteSecrets, requiredNames, providedNames) {
  const provided = requiredNames.filter((name) => providedNames.has(name));
  if (provided.length > 0 && provided.length !== requiredNames.length) {
    throw new Error(`Provide all required Worker secrets together: ${requiredNames.join(", ")}.`);
  }
  if (provided.length === requiredNames.length) return "provision";
  if (remoteSecrets === null) {
    throw new Error(
        `Unable to verify required Worker secrets: ${requiredNames.join(", ")}. ` +
        "Provide the deployment inputs before the first deployment.",
    );
  }
  const missing = requiredNames.filter((name) => !remoteSecrets.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required Worker secrets: ${missing.join(", ")}.`);
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

function putRemoteSecrets(configPath, secrets) {
  const names = Object.keys(secrets);
  console.log(`\n> wrangler secret bulk ${names.join(", ")} --config ${configPath} (values via stdin)`);
  execFileSync(
      process.execPath,
      [WRANGLER_CLI, "secret", "bulk", "--config", configPath],
      {
        cwd: ROOT,
        input: JSON.stringify(secrets),
        stdio: ["pipe", "inherit", "inherit"],
      },
  );
}

export function parseArgs(argv) {
  const args = {
    domain: undefined,
    admin: undefined,
    clearAdmins: false,
    cloudflareLimitsEnabled: undefined,
    dailyLlmCallLimit: undefined,
    minimumCloudflareBalance: undefined,
    realtimeConsoleEnabled: undefined,
    workspaceBlobMode: undefined,
    workspaceAttachmentLimitBytes: undefined,
    workspaceAttachmentLimitCount: undefined,
    accessIssuer: undefined,
    accessAudience: undefined,
    flagshipAppId: undefined,
    productAnalyticsStreamId: undefined,
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
    else if (argv[i] === "--clear-admins") args.clearAdmins = true;
    else if (argv[i] === "--enable-cloudflare-limits") {
      if (args.cloudflareLimitsEnabled === false) {
        throw new Error(
            "--enable-cloudflare-limits and --disable-cloudflare-limits cannot be used together");
      }
      args.cloudflareLimitsEnabled = true;
    }
    else if (argv[i] === "--disable-cloudflare-limits") {
      if (args.cloudflareLimitsEnabled === true) {
        throw new Error(
            "--enable-cloudflare-limits and --disable-cloudflare-limits cannot be used together");
      }
      args.cloudflareLimitsEnabled = false;
    }
    else if (argv[i] === "--daily-llm-call-limit") {
      args.dailyLlmCallLimit = normalizeDailyLlmCallLimit(readValue(argv[i], i++));
    }
    else if (argv[i] === "--minimum-cloudflare-balance") {
      args.minimumCloudflareBalance = normalizeMinimumCloudflareBalance(readValue(argv[i], i++));
    }
    else if (argv[i] === "--enable-realtime-console") {
      if (args.realtimeConsoleEnabled === false) {
        throw new Error(
            "--enable-realtime-console and --disable-realtime-console cannot be used together");
      }
      args.realtimeConsoleEnabled = true;
    }
    else if (argv[i] === "--disable-realtime-console") {
      if (args.realtimeConsoleEnabled === true) {
        throw new Error(
            "--enable-realtime-console and --disable-realtime-console cannot be used together");
      }
      args.realtimeConsoleEnabled = false;
    }
    else if (argv[i] === "--workspace-blob-mode") {
      args.workspaceBlobMode = normalizeWorkspaceBlobMode(readValue(argv[i], i++));
    }
    else if (argv[i] === "--workspace-attachment-limit-bytes") {
      args.workspaceAttachmentLimitBytes = normalizePositiveInteger(
          readValue(argv[i], i++), "--workspace-attachment-limit-bytes");
    }
    else if (argv[i] === "--workspace-attachment-limit-count") {
      args.workspaceAttachmentLimitCount = normalizePositiveInteger(
          readValue(argv[i], i++), "--workspace-attachment-limit-count", 100_000);
    }
    else if (argv[i] === "--access-issuer") args.accessIssuer = readValue(argv[i], i++);
    else if (argv[i] === "--access-audience") args.accessAudience = readValue(argv[i], i++);
    else if (argv[i] === "--flagship-app-id") args.flagshipAppId = readValue(argv[i], i++);
    else if (argv[i] === "--product-analytics-stream-id") {
      args.productAnalyticsStreamId = readValue(argv[i], i++);
    }
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
  if (args.admin !== undefined && args.clearAdmins) {
    throw new Error("--admin and --clear-admins cannot be used together");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Consume the deployment-only secret before launching build subprocesses. It is never written to
  // generated Wrangler config and is passed only to `wrangler secret put` over stdin.
  const aiGatewayToken = process.env[AI_GATEWAY_TOKEN_INPUT_ENV]?.trim();
  delete process.env[AI_GATEWAY_TOKEN_INPUT_ENV];
  const githubSecrets = Object.fromEntries(GITHUB_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedGithubSecretNames = new Set(
      Object.entries(githubSecrets).filter(([, value]) => Boolean(value)).map(([name]) => name),
  );
  const googleSecrets = Object.fromEntries(GOOGLE_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedGoogleSecretNames = new Set(
      Object.entries(googleSecrets).filter(([, value]) => Boolean(value)).map(([name]) => name),
  );
  const cloudflareSecrets = Object.fromEntries(CLOUDFLARE_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedCloudflareSecretNames = new Set(
      Object.entries(cloudflareSecrets)
          .filter(([, value]) => Boolean(value))
          .map(([name]) => name),
  );
  const confluenceSecrets = Object.fromEntries(CONFLUENCE_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedConfluenceSecretNames = new Set(
      Object.entries(confluenceSecrets)
          .filter(([, value]) => Boolean(value))
          .map(([name]) => name),
  );
  const linearSecrets = Object.fromEntries(LINEAR_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedLinearSecretNames = new Set(
      Object.entries(linearSecrets)
          .filter(([, value]) => Boolean(value))
          .map(([name]) => name),
  );
  const notionSecrets = Object.fromEntries(NOTION_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedNotionSecretNames = new Set(
      Object.entries(notionSecrets)
          .filter(([, value]) => Boolean(value))
          .map(([name]) => name),
  );
  const supabaseSecrets = Object.fromEntries(SUPABASE_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedSupabaseSecretNames = new Set(
      Object.entries(supabaseSecrets)
          .filter(([, value]) => Boolean(value))
          .map(([name]) => name),
  );
  const slackSecrets = Object.fromEntries(SLACK_SECRET_INPUTS.map(([name, inputEnv]) => {
    const value = process.env[inputEnv]?.trim();
    delete process.env[inputEnv];
    return [name, value];
  }));
  const providedSlackSecretNames = new Set(
      Object.entries(slackSecrets)
          .filter(([, value]) => Boolean(value))
          .map(([name]) => name),
  );
  const instance = createInstanceConfigs({
    domain: args.domain,
    admin: args.admin?.trim(),
    clearAdmins: args.clearAdmins,
    cloudflareLimitsEnabled: args.cloudflareLimitsEnabled,
    dailyLlmCallLimit: args.dailyLlmCallLimit,
    minimumCloudflareBalance: args.minimumCloudflareBalance,
    realtimeConsoleEnabled: args.realtimeConsoleEnabled,
    workspaceBlobMode: args.workspaceBlobMode,
    workspaceAttachmentLimitBytes: args.workspaceAttachmentLimitBytes,
    workspaceAttachmentLimitCount: args.workspaceAttachmentLimitCount,
    accessIssuer: args.accessIssuer,
    accessAudience: args.accessAudience,
    flagshipAppId: args.flagshipAppId,
    productAnalyticsStreamId: args.productAnalyticsStreamId,
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
  for (const packageName of [
    "@gadgets/cloudflare-gatekeeper",
    "@gadgets/confluence-gatekeeper",
    "@gadgets/homeassistant-gatekeeper",
    "@gadgets/linear-gatekeeper",
    "@gadgets/notion-gatekeeper",
    "@gadgets/supabase-gatekeeper",
    "@gadgets/slack-gatekeeper",
    "@gadgets/mcp-gatekeeper",
    "@gadgets/github-gatekeeper",
    "@gadgets/google-gatekeeper",
    "@gadgets/email-gatekeeper",
  ]) {
    run(process.execPath, [
      VITE_PLUS_CLI,
      "run",
      "-F",
      packageName,
      "--no-cache",
      "build:configurator",
    ]);
  }
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

  const githubConfigPath = instance.configPaths["gatekeeper-github"];
  const githubSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(githubConfigPath),
        GITHUB_SECRET_INPUTS.map(([name]) => name),
        providedGithubSecretNames,
    );
  const googleConfigPath = instance.configPaths["gatekeeper-google"];
  const googleSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(googleConfigPath),
        GOOGLE_SECRET_INPUTS.map(([name]) => name),
        providedGoogleSecretNames,
    );
  const cloudflareConfigPath = instance.configPaths["gatekeeper-cloudflare"];
  const cloudflareSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(cloudflareConfigPath),
        CLOUDFLARE_SECRET_INPUTS.map(([name]) => name),
        providedCloudflareSecretNames,
    );
  const confluenceConfigPath = instance.configPaths["gatekeeper-confluence"];
  const confluenceSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(confluenceConfigPath),
        CONFLUENCE_SECRET_INPUTS.map(([name]) => name),
        providedConfluenceSecretNames,
    );
  const linearConfigPath = instance.configPaths["gatekeeper-linear"];
  const linearSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(linearConfigPath),
        LINEAR_SECRET_INPUTS.map(([name]) => name),
        providedLinearSecretNames,
    );
  const notionConfigPath = instance.configPaths["gatekeeper-notion"];
  const notionSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(notionConfigPath),
        NOTION_SECRET_INPUTS.map(([name]) => name),
        providedNotionSecretNames,
    );
  const supabaseConfigPath = instance.configPaths["gatekeeper-supabase"];
  const supabaseSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(supabaseConfigPath),
        SUPABASE_SECRET_INPUTS.map(([name]) => name),
        providedSupabaseSecretNames,
    );
  const slackConfigPath = instance.configPaths["gatekeeper-slack"];
  const slackSecretAction = args.dryRun
    ? "dry-run"
    : planRequiredWorkerSecrets(
        readRemoteSecretNames(slackConfigPath),
        SLACK_SECRET_INPUTS.map(([name]) => name),
        providedSlackSecretNames,
    );

  for (const packageName of CORE_PACKAGES) {
    const deployArgs = [
      "deploy",
      "--config",
      instance.configPaths[packageName],
      "--keep-vars",
    ];
    if (args.dryRun) deployArgs.push("--dry-run");
    runWrangler(deployArgs);
    if (packageName === "gatekeeper-github" && githubSecretAction === "provision") {
      putRemoteSecrets(githubConfigPath, githubSecrets);
    }
    if (packageName === "gatekeeper-google" && googleSecretAction === "provision") {
      putRemoteSecrets(googleConfigPath, googleSecrets);
    }
    if (packageName === "gatekeeper-cloudflare" && cloudflareSecretAction === "provision") {
      putRemoteSecrets(cloudflareConfigPath, cloudflareSecrets);
    }
    if (packageName === "gatekeeper-confluence" && confluenceSecretAction === "provision") {
      putRemoteSecrets(confluenceConfigPath, confluenceSecrets);
    }
    if (packageName === "gatekeeper-linear" && linearSecretAction === "provision") {
      putRemoteSecrets(linearConfigPath, linearSecrets);
    }
    if (packageName === "gatekeeper-notion" && notionSecretAction === "provision") {
      putRemoteSecrets(notionConfigPath, notionSecrets);
    }
    if (packageName === "gatekeeper-supabase" && supabaseSecretAction === "provision") {
      putRemoteSecrets(supabaseConfigPath, supabaseSecrets);
    }
    if (packageName === "gatekeeper-slack" && slackSecretAction === "provision") {
      putRemoteSecrets(slackConfigPath, slackSecrets);
    }
  }

  console.log(args.dryRun
    ? `\nCloudflare dry-run passed for ${instance.publicBaseUrl}.`
    : `\nCinaSeek deployed to ${instance.publicBaseUrl}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
