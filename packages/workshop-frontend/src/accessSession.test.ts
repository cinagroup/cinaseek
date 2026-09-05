// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_LOGIN_REQUEST_EVENT,
  accessLoginUrl,
  consumePendingHomePrompt,
  currentReturnTo,
  logoutAccessSession,
  peekPendingHomePrompt,
  probeAccessSession,
  requestAccessLogin,
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

describe('Access logout', () => {
  it('waits for the authenticated logout request and a fresh guest probe', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Access logout page', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(logoutAccessSession(fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/cdn-cgi/access/logout', {
      method: 'GET', credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/session', expect.objectContaining({
      cache: 'no-store', credentials: 'same-origin', redirect: 'manual',
      signal: expect.any(AbortSignal),
    }));
  });

  it('verifies a logout redirect instead of navigating to the Access page', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(logoutAccessSession(fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not accept a success page when the session is still authenticated', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Success', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(logoutAccessSession(fetchImpl)).rejects.toThrow('Could not confirm');
  });

  it('does not accept an unavailable or misrouted session probe as logout', async () => {
    for (const status of [200, 500]) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status }));
      await expect(logoutAccessSession(fetchImpl)).rejects.toThrow('Could not confirm');
    }
  });

  it('fails on logout server and network errors without probing', async () => {
    const failed = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(logoutAccessSession(failed)).rejects.toThrow('logout failed');
    expect(failed).toHaveBeenCalledOnce();
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(logoutAccessSession(offline)).rejects.toThrow('offline');
    expect(offline).toHaveBeenCalledOnce();
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

  it("requests the login popup without navigating the guest page", () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(ACCESS_LOGIN_REQUEST_EVENT, listener);
    requestAccessLogin("/workspaces");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      returnTo: "/workspaces",
    });
    window.removeEventListener(ACCESS_LOGIN_REQUEST_EVENT, listener);
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
