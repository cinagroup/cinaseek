import { describe, expect, it, vi } from "vitest";
import {
  accessRateLimitKey,
  getCfAccessConfig,
  getCfAccessIdentity,
  hasCfAccessConfiguration,
  verifyCfAccessJwt,
} from "../src/access.js";

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn().mockResolvedValue({ payload: { sub: "user-1" } }),
}));

vi.mock("jose", () => joseMocks);

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

describe("verifyCfAccessJwt", () => {
  it("reuses the remote JWK set for requests with the same issuer", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const otherEnv = {
      ...accessEnv,
      CF_ACCESS_ISS: "https://other-team.cloudflareaccess.com",
    };

    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, otherEnv);

    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledTimes(2);
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      1, new URL("https://team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      2, new URL("https://other-team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
    expect(joseMocks.jwtVerify).toHaveBeenCalledWith(
      "signed-token",
      expect.any(Function),
      {
        issuer: "https://team.cloudflareaccess.com",
        audience: "workshop-audience",
        algorithms: ["RS256"],
      },
    );
  });

  it("rejects missing and invalid assertions", async () => {
    const requestWithoutToken = new Request("https://workshop.example/api/client-errors");
    const verifier = vi.fn();
    const missing = await verifyCfAccessJwt(requestWithoutToken, accessEnv, verifier);
    expect(missing).toBeNull();
    expect(verifier).not.toHaveBeenCalled();

    const requestWithToken = new Request("https://workshop.example/api/client-errors", {
      headers: { "cf-access-jwt-assertion": "invalid" },
    });
    verifier.mockRejectedValue(new Error("invalid signature"));
    const invalid = await verifyCfAccessJwt(requestWithToken, accessEnv, verifier);
    expect(invalid).toBeNull();
  });

  it("returns claims only after verification", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const verifier = vi.fn().mockResolvedValue({
      sub: "user-1", email: "person@example.com",
    });

    await expect(verifyCfAccessJwt(request, accessEnv, verifier)).resolves.toEqual({
      sub: "user-1", email: "person@example.com",
    });
  });

  it("rejects a partial or invalid runtime configuration before verification", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const verifier = vi.fn();

    await expect(verifyCfAccessJwt(request, {
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    }, verifier)).resolves.toBeNull();
    await expect(verifyCfAccessJwt(request, {
      CF_ACCESS_AUD: "workshop-audience",
      CF_ACCESS_ISS: "https://metadata.example.com",
    }, verifier)).resolves.toBeNull();
    expect(verifier).not.toHaveBeenCalled();
  });
});

describe("getCfAccessConfig", () => {
  it("distinguishes disabled, partial, and complete Access settings", () => {
    expect(hasCfAccessConfiguration({})).toBe(false);
    expect(hasCfAccessConfiguration({ CF_ACCESS_AUD: "", CF_ACCESS_ISS: "" })).toBe(false);
    expect(hasCfAccessConfiguration({ CF_ACCESS_AUD: "audience" })).toBe(true);
    expect(getCfAccessConfig({})).toBeNull();
    expect(() => getCfAccessConfig({ CF_ACCESS_AUD: "audience" })).toThrow(/both be configured/);
    expect(getCfAccessConfig({
      CF_ACCESS_AUD: " audience ",
      CF_ACCESS_ISS: "https://TEAM.cloudflareaccess.com/",
    })).toEqual({
      audience: "audience",
      issuer: "https://team.cloudflareaccess.com",
    });
  });

  it("rejects unsafe issuer and audience values", () => {
    expect(() => getCfAccessConfig({
      CF_ACCESS_AUD: "two values",
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    })).toThrow(/audience is invalid/);
    expect(() => getCfAccessConfig({
      CF_ACCESS_AUD: "audience",
      CF_ACCESS_ISS: "http://team.cloudflareaccess.com",
    })).toThrow(/issuer is invalid/);
    expect(() => getCfAccessConfig({
      CF_ACCESS_AUD: "audience",
      CF_ACCESS_ISS: "https://team.cloudflareaccess.com/tenant",
    })).toThrow(/issuer is invalid/);
  });
});

describe("accessRateLimitKey", () => {
  it("uses the verified subject and hashes email only as a fallback", async () => {
    await expect(accessRateLimitKey({ sub: "user-1", email: "person@example.com" }))
      .resolves.toBe("access-sub:user-1");
    const emailKey = await accessRateLimitKey({ email: "person@example.com" });
    expect(emailKey).toMatch(/^access-email:[0-9a-f]{64}$/);
    expect(emailKey).not.toContain("person@example.com");
  });
});

describe("getCfAccessIdentity", () => {
  it("normalizes the verified email and retains the Access subject", () => {
    expect(getCfAccessIdentity({
      type: "app", email: " Person@Example.COM ", sub: " user-1 ",
    })).toEqual({
      email: "person@example.com",
      subject: "user-1",
    });
  });

  it("rejects non-application assertions without a complete usable identity", () => {
    expect(getCfAccessIdentity({ type: "app", sub: "user-1" })).toBeNull();
    expect(getCfAccessIdentity({ type: "app", email: "person@example.com" })).toBeNull();
    expect(getCfAccessIdentity({
      type: "org", email: "person@example.com", sub: "user-1",
    })).toBeNull();
    expect(getCfAccessIdentity({ type: "app", email: "invalid", sub: "user-1" })).toBeNull();
    expect(getCfAccessIdentity({
      type: "app", email: ["person@example.com"], sub: "user-1",
    })).toBeNull();
  });
});
