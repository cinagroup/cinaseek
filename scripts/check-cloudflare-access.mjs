#!/usr/bin/env node

// Read-only production audit for a standalone CinaSeek Cloudflare Access deployment. The API
// token is read only from the environment; application identifiers and policy subjects are never
// printed, so the command is suitable for CI logs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import {
  instanceSlug,
  normalizeAccessAudience,
  normalizeAccessIssuer,
  normalizeDomain,
  verifyAccessEdge,
} from "./deploy-cloudflare.mjs";

const API_BASE = "https://api.cloudflare.com/client/v4";

function ruleType(rule) {
  return rule && typeof rule === "object" ? Object.keys(rule)[0] : undefined;
}

function policyIncludesGroup(policy, groupId) {
  return Array.isArray(policy.include) && policy.include.some(
      (rule) => ruleType(rule) === "group" && rule.group?.id === groupId);
}

/** Evaluates Access API resources without exposing policy subjects or provider credentials. */
export function evaluateAccessResources({
  domain,
  audience,
  requiredIdps = [],
  requiredGroups = [],
  applications,
  identityProviders,
  policies,
  groups,
}) {
  const failures = [];
  const app = applications.find((candidate) => candidate.domain === domain);
  if (!app) return [`No Cloudflare Access application protects ${domain}.`];

  if (app.type !== "self_hosted") failures.push("The Access application must be self-hosted.");
  if (app.aud !== audience) failures.push("The Access application AUD does not match deployment.");
  if (app.http_only_cookie_attribute !== true) {
    failures.push("The Access application must use an HttpOnly authorization cookie.");
  }

  const allowedIdps = new Set(Array.isArray(app.allowed_idps) ? app.allowed_idps : []);
  for (const requiredName of requiredIdps) {
    const provider = identityProviders.find(
        (candidate) => candidate.name?.toLowerCase() === requiredName.toLowerCase());
    if (!provider) {
      failures.push(`Required identity provider ${requiredName} does not exist.`);
    } else if (!allowedIdps.has(provider.id)) {
      failures.push(`Required identity provider ${requiredName} is not allowed by the application.`);
    }
  }

  if (policies.some((policy) => policy.decision === "bypass")) {
    failures.push("Bypass policies are not allowed for the production application.");
  }
  const allowPolicies = policies.filter((policy) => policy.decision === "allow");
  if (allowPolicies.length === 0) failures.push("The application has no Allow policy.");
  if (allowPolicies.some((policy) =>
    Array.isArray(policy.include) && policy.include.some((rule) => ruleType(rule) === "everyone"))) {
    failures.push("An Allow policy includes Everyone.");
  }
  const identityRuleTypes = new Set(["email", "email_domain", "group"]);
  if (allowPolicies.some((policy) => !Array.isArray(policy.include) ||
      policy.include.length === 0 ||
      policy.include.some((rule) => !identityRuleTypes.has(ruleType(rule))))) {
    failures.push(
        "Every Allow policy include rule must use email, email domain, or Access group.");
  }

  for (const requiredName of requiredGroups) {
    const group = groups.find(
        (candidate) => candidate.name?.toLowerCase() === requiredName.toLowerCase());
    if (!group) {
      failures.push(`Required Access group ${requiredName} does not exist.`);
    } else if (!allowPolicies.some((policy) => policyIncludesGroup(policy, group.id))) {
      failures.push(`Required Access group ${requiredName} is not used by an Allow policy.`);
    }
  }

  return failures;
}

function parseArgs(argv) {
  const result = { requiredIdps: [], requiredGroups: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--domain" && value) {
      result.domain = value;
      index++;
    } else if (arg === "--config" && value) {
      result.config = value;
      index++;
    } else if (arg === "--require-idp" && value) {
      result.requiredIdps.push(value);
      index++;
    } else if (arg === "--require-access-group" && value) {
      result.requiredGroups.push(value);
      index++;
    } else if (arg === "--help") {
      result.help = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  return result;
}

function usage() {
  return [
    "Usage: node scripts/check-cloudflare-access.mjs --domain <hostname> [options]",
    "",
    "Options:",
    "  --config <path>                 Generated workshop-backend Wrangler config",
    "  --require-idp <name>            Require and allow an identity provider (repeatable)",
    "  --require-access-group <name>   Require an Access group in an Allow policy (repeatable)",
  ].join("\n");
}

async function cloudflareJson(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const message = body.errors?.map((error) => error.message).join("; ") ||
      `HTTP ${response.status}`;
    throw new Error(`Cloudflare API request failed: ${message}`);
  }
  return body.result;
}

async function resolveAccountId(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await cloudflareJson("/accounts?per_page=50", token);
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID when the token does not resolve exactly one account.");
  }
  return accounts[0].id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.domain) throw new Error("--domain is required");

  const domain = normalizeDomain(args.domain);
  const configPath = resolve(args.config ??
    `.wrangler/production/${instanceSlug(domain)}/workshop-backend.jsonc`);
  const config = parse(readFileSync(configPath, "utf8"));
  const issuer = normalizeAccessIssuer(config.vars?.CF_ACCESS_ISS ?? "");
  const audience = normalizeAccessAudience(config.vars?.CF_ACCESS_AUD ?? "");
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN or CF_API_TOKEN is required");

  const accountId = await resolveAccountId(token);
  const applications = await cloudflareJson(
      `/accounts/${accountId}/access/apps?per_page=100`, token);
  const app = applications.find((candidate) => candidate.domain === domain);
  const [identityProviders, groups, policies] = await Promise.all([
    cloudflareJson(`/accounts/${accountId}/access/identity_providers?per_page=100`, token),
    cloudflareJson(`/accounts/${accountId}/access/groups?per_page=100`, token),
    app
      ? cloudflareJson(`/accounts/${accountId}/access/apps/${app.id}/policies?per_page=100`, token)
      : Promise.resolve([]),
  ]);

  const failures = evaluateAccessResources({
    domain,
    audience,
    requiredIdps: args.requiredIdps,
    requiredGroups: args.requiredGroups,
    applications,
    identityProviders,
    policies,
    groups,
  });
  try {
    await verifyAccessEdge({ domain, issuer });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) {
    console.error("Cloudflare Access production audit failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Cloudflare Access production audit passed for https://${domain}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
