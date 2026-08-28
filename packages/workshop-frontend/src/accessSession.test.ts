// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessLoginUrl,
  consumePendingHomePrompt,
  currentReturnTo,
  peekPendingHomePrompt,
  probeAccessSession,
  savePendingHomePrompt,
} from "./accessSession";

describe("Access session probe", () => {
  it("recognizes a verified session without reading the Access cookie", async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    await expect(probeAccessSession(fetchImpl as typeof fetch)).resolves.toBe("authenticated");
    expect(fetchImpl).toHaveBeenCalledWith("/api/session", expect.objectContaining({
      credentials: "same-origin",
      redirect: "manual",
      headers: expect.objectContaining({ "x-requested-with": "XMLHttpRequest" }),
    }));
  });

  it("treats Access denials and login redirects as a guest session", async () => {
    for (const status of [302, 401, 403]) {
      const fetchImpl = vi.fn<() => Promise<Response>>(
        async () => new Response(null, { status }),
      );
      await expect(probeAccessSession(fetchImpl as typeof fetch)).resolves.toBe("guest");
    }
  });

  it("separates routing/server failures from an ordinary guest", async () => {
    await expect(probeAccessSession(
      vi.fn<() => Promise<Response>>(
        async () => new Response("SPA fallback", { status: 200 }),
      ) as typeof fetch,
    )).resolves.toBe("error");
    await expect(probeAccessSession(
      vi.fn<() => Promise<Response>>(
        async () => { throw new Error("offline"); },
      ) as typeof fetch,
    )).resolves.toBe("error");
  });
});

describe("Access login and guest draft", () => {
  afterEach(() => sessionStorage.clear());

  it("keeps login navigation same-origin and preserves the requested route", () => {
    expect(accessLoginUrl("/workspace/abc?chat=1")).toBe(
      "/auth/login?returnTo=%2Fworkspace%2Fabc%3Fchat%3D1",
    );
    const location = {
      pathname: "/profile",
      search: "?tab=usage",
      hash: "#limits",
    } as Location;
    expect(currentReturnTo(location)).toBe("/profile?tab=usage#limits");
  });

  it("stores prompts only in tab-scoped storage and consumes them once", () => {
    savePendingHomePrompt("Build a private dashboard");
    expect(peekPendingHomePrompt()).toBe("Build a private dashboard");
    expect(consumePendingHomePrompt()).toBe("Build a private dashboard");
    expect(peekPendingHomePrompt()).toBeNull();
  });

  it("clears an empty draft", () => {
    savePendingHomePrompt("draft");
    savePendingHomePrompt("");
    expect(peekPendingHomePrompt()).toBeNull();
  });
});
