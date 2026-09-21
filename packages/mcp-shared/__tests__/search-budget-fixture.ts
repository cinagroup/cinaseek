import { vi } from "vitest";
import type { GatekeeperSearchBudget } from "@gadgets/workshop-shared/gatekeeper";

/** In-memory RPC method fixture; no production budget or real provider is contacted. */
export function searchBudget() {
  return {
    reserve: vi.fn<GatekeeperSearchBudget["reserve"]>(async () => ({
      expiresAt: Date.now() + 60_000, [Symbol.dispose]() {},
    })),
    settle: vi.fn<GatekeeperSearchBudget["settle"]>(async () => {}),
  };
}

/** A local fixture, not a production capability minting path. */
export function storedSearchBudget(): Fetcher<GatekeeperSearchBudget> {
  return searchBudget() as unknown as Fetcher<GatekeeperSearchBudget>;
}
