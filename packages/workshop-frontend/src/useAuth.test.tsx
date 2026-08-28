// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("useAuth in Cloudflare Access mode", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function renderWith(
      authenticatedApi: RpcStub<AuthenticatedApi>,
      accessSessionStatus: 'checking' | 'guest' | 'authenticated' | 'error' = 'authenticated',
  ): Promise<() => { isLoading: boolean; error: string | null; isAuthenticated: boolean }> {
    vi.stubEnv("VITE_CF_ACCESS_MODE", "true");
    vi.resetModules();
    const { useAuth } = await import("./useAuth");
    const publicApi = {
      authenticateFromCfAccess: vi.fn<() => RpcStub<AuthenticatedApi>>(() => authenticatedApi),
    } as unknown as RpcStub<PublicApi>;
    let current: ReturnType<typeof useAuth> | undefined;

    function Probe() {
      current = useAuth(publicApi, accessSessionStatus);
      return null;
    }

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Probe />));

    return () => {
      if (!current) throw new Error("auth hook did not render");
      return current;
    };
  }

  it("does not expose an authenticated session until the pipelined probe succeeds", async () => {
    const probe = deferred<{ type: "user"; id: string; name: string }>();
    const dispose = vi.fn<() => void>();
    const authenticatedApi = {
      whoami: vi.fn<() => typeof probe.promise>(() => probe.promise),
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<AuthenticatedApi>;
    const current = await renderWith(authenticatedApi);

    expect(current()).toMatchObject({ isLoading: true, isAuthenticated: false, error: null });

    await act(async () => {
      probe.resolve({ type: "user", id: "user@example.com", name: "User" });
      await probe.promise;
    });
    expect(current()).toMatchObject({ isLoading: false, isAuthenticated: true, error: null });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("surfaces an Access failure and disposes the rejected capability", async () => {
    const probe = deferred<never>();
    const dispose = vi.fn<() => void>();
    const authenticatedApi = {
      whoami: vi.fn<() => Promise<never>>(() => probe.promise),
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<AuthenticatedApi>;
    const current = await renderWith(authenticatedApi);

    await act(async () => {
      probe.reject(new Error("Not authenticated with Access."));
      await probe.promise.catch(() => undefined);
    });
    expect(current()).toMatchObject({
      isLoading: false,
      isAuthenticated: false,
      error: "Not authenticated with Access.",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("renders an ordinary guest without opening an authenticated capability", async () => {
    const authenticatedApi = {
      whoami: vi.fn<() => Promise<never>>(),
      [Symbol.dispose]: vi.fn<() => void>(),
    } as unknown as RpcStub<AuthenticatedApi>;
    const current = await renderWith(authenticatedApi, 'guest');

    expect(current()).toMatchObject({ isLoading: false, isAuthenticated: false, error: null });
    expect(authenticatedApi.whoami).not.toHaveBeenCalled();
  });
});
