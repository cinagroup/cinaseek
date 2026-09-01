import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAccessResources, findAccessApplication } from "./check-cloudflare-access.mjs";

const resources = () => ({
  domain: "cinaseek.ai",
  audience: "expected-aud",
  instantAuthIdp: "CinaAuth",
  requiredGroups: ["CinaSeek administrators"],
  applications: [{
    id: "app-id",
    domain: "cinaseek.ai/auth/login",
    destinations: [
      { type: "public", uri: "cinaseek.ai/auth/login" },
      { type: "public", uri: "cinaseek.ai/api" },
      { type: "public", uri: "cinaseek.ai/api/*" },
    ],
    type: "self_hosted",
    aud: "expected-aud",
    http_only_cookie_attribute: true,
    allowed_idps: ["cinaauth-id"],
    auto_redirect_to_identity: true,
  }],
  identityProviders: [
    { id: "google-id", name: "Google" },
    { id: "github-id", name: "GitHub" },
    { id: "cinaauth-id", name: "CinaAuth" },
  ],
  groups: [{ id: "admins-id", name: "CinaSeek administrators" }],
  policies: [{
    decision: "allow",
    include: [{ group: { id: "admins-id" } }],
  }],
});

test("accepts exclusive CinaAuth with instant authentication", () => {
  assert.deepEqual(evaluateAccessResources(resources()), []);
});

test("reports an AUD mismatch and a missing instant authentication identity provider", () => {
  const input = resources();
  input.applications[0].aud = "other-aud";
  input.identityProviders = input.identityProviders.filter((provider) => provider.name !== "CinaAuth");
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("AUD")));
  assert(failures.some((failure) => failure.includes("CinaAuth")));
});

test("rejects another allowed IdP or disabled instant authentication", () => {
  const input = resources();
  input.applications[0].allowed_idps.push("google-id");
  input.applications[0].auto_redirect_to_identity = false;
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("only allowed identity provider")));
  assert(failures.some((failure) => failure.includes("enable instant authentication")));
});

test("rejects bypass and Everyone policies", () => {
  const input = resources();
  input.policies.push({ decision: "bypass", include: [{ everyone: {} }] });
  input.policies[0].include = [{ everyone: {} }];
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("Bypass")));
  assert(failures.some((failure) => failure.includes("Everyone")));
  assert(failures.some((failure) => failure.includes("Every Allow policy include rule")));
});

test("rejects non-identity include rules even beside a valid group", () => {
  const input = resources();
  input.policies[0].include.push({ ip: { ip: "192.0.2.0/24" } });
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("Every Allow policy include rule")));
});

test("requires named Access groups to be used by an Allow policy", () => {
  const input = resources();
  input.policies[0].include = [{ email: { email: "admin@example.com" } }];
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("is not used")));
});

test("accepts one application with path-scoped authentication destinations", () => {
  const input = resources();
  input.applications[0].domain = "cinaseek.ai/auth/login";
  input.applications[0].destinations = [
    { type: "public", uri: "cinaseek.ai/auth/login" },
    { type: "public", uri: "cinaseek.ai/api" },
    { type: "public", uri: "cinaseek.ai/api/*" },
  ];
  assert.equal(findAccessApplication(input.applications, "cinaseek.ai")?.id, "app-id");
  assert.deepEqual(evaluateAccessResources(input), []);
});

test("does not let an API child wildcard stand in for the exact parent", () => {
  const input = resources();
  input.applications[0].destinations = [
    { type: "public", uri: "cinaseek.ai/auth/login" },
    { type: "public", uri: "cinaseek.ai/api/*" },
  ];
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("/api")));
});

test("rejects Access destinations that intercept Gatekeeper OAuth", () => {
  const input = resources();
  input.applications[0].destinations.push(
      { type: "public", uri: "cinaseek.ai/gatekeeper/*" });
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("Gatekeeper OAuth routes")));
});

test("rejects a whole-host Access destination because it also intercepts Gatekeepers", () => {
  const input = resources();
  input.applications[0].domain = "cinaseek.ai";
  delete input.applications[0].destinations;
  const failures = evaluateAccessResources(input);
  assert(failures.some((failure) => failure.includes("Gatekeeper OAuth routes")));
});
