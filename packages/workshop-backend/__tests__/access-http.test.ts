import { describe, expect, it, vi } from "vitest";
import {
  handleAccessLoginRequest,
  handleAccessSessionRequest,
  safeAccessReturnPath,
} from "../src/access-http.js";

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

const validClaims = {
  type: "app",
  sub: "user-1",
  email: "person@example.com",
};

describe("Access HTTP session endpoint", () => {
  it("returns a no-store 204 only for a verified application identity", async () => {
    const verifier = vi.fn(async () => validClaims);
    const response = await handleAccessSessionRequest(
      new Request("https://workshop.example/api/session"),
      accessEnv,
      verifier,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(verifier).toHaveBeenCalledOnce();
  });

  it("fails closed for missing identity and incomplete configuration", async () => {
    const invalid = await handleAccessSessionRequest(
      new Request("https://workshop.example/api/session"),
      accessEnv,
      vi.fn(async () => null),
    );
    expect(invalid.status).toBe(401);

    const partial = await handleAccessSessionRequest(
      new Request("https://workshop.example/api/session"),
      { CF_ACCESS_AUD: "workshop-audience" },
      vi.fn(async () => validClaims),
    );
    expect(partial.status).toBe(503);

    const disabled = await handleAccessSessionRequest(
      new Request("https://workshop.example/api/session"),
      {},
      vi.fn(async () => validClaims),
    );
    expect(disabled.status).toBe(404);
  });

  it("rejects state-changing methods", async () => {
    const response = await handleAccessSessionRequest(
      new Request("https://workshop.example/api/session", { method: "POST" }),
      accessEnv,
      vi.fn(async () => validClaims),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("Access login redirect", () => {
  it("preserves a validated same-origin route", async () => {
    const response = await handleAccessLoginRequest(
      new Request(
        "https://workshop.example/auth/login?returnTo=%2Fworkspace%2Fabc%3Fchat%3D1%23latest",
      ),
      accessEnv,
      vi.fn(async () => validClaims),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/workspace/abc?chat=1#latest");
  });

  it("requires a verified application identity", async () => {
    const response = await handleAccessLoginRequest(
      new Request("https://workshop.example/auth/login?returnTo=%2Fprofile"),
      accessEnv,
      vi.fn(async () => ({ type: "org", sub: "user-1", email: "person@example.com" })),
    );
    expect(response.status).toBe(401);
  });
});

describe("safeAccessReturnPath", () => {
  it("accepts application-relative paths", () => {
    expect(safeAccessReturnPath("/profile")).toBe("/profile");
    expect(safeAccessReturnPath("/workspace/abc?chat=1#latest"))
      .toBe("/workspace/abc?chat=1#latest");
  });

  it("rejects external, ambiguous, and recursive redirects", () => {
    for (const value of [
      null,
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/%2Fevil.example/",
      "/%5Cevil.example/",
      "/auth/login",
      "/auth/login/again",
      "/cdn-cgi/access/logout",
    ]) {
      expect(safeAccessReturnPath(value)).toBe("/");
    }
  });
});
