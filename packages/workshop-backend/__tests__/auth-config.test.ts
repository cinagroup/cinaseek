import { describe, expect, it } from "vitest";
import { isPasswordAuthEnabled } from "../src/auth/config.js";

function env(values: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return values as Cloudflare.Env;
}

describe("isPasswordAuthEnabled", () => {
  it("disables password authentication for complete and partial Access configuration", () => {
    expect(isPasswordAuthEnabled(env({
      CF_ACCESS_AUD: "audience",
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    }))).toBe(false);
    expect(isPasswordAuthEnabled(env({ CF_ACCESS_AUD: "audience" }))).toBe(false);
    expect(isPasswordAuthEnabled(env({
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    }))).toBe(false);
  });

  it("keeps the non-Access lockout guard for gatekeeper sign-in", () => {
    expect(isPasswordAuthEnabled(env())).toBe(true);
    expect(isPasswordAuthEnabled(env({ DISABLE_PASSWORD_AUTH: "true" }))).toBe(true);
    expect(isPasswordAuthEnabled(env({
      DISABLE_PASSWORD_AUTH: "true",
      AUTH_GATEKEEPERS: "google",
    }))).toBe(false);
  });
});
