import { describe, expect, it } from "vitest";
import { reserveSearchBudget, settleSearchBudget } from "../src/search-budget.js";

const start = Date.parse("2026-09-21T12:00:00Z");
const id = (now: number) => `${now}:${crypto.randomUUID()}`;

/** Runs the same accounting invariants against unit storage and real SQLite-backed DO storage. */
export function searchBudgetCases(ledger: (test: (store: Pick<SyncKvStorage, "get" | "put">) => void) => Promise<void>) {
describe("user-wide search budget accounting", () => {
  it("shares concurrency across connections but separates providers and users", async () => {
    await ledger(store => {
      reserveSearchBudget(store, 1, "tavily", id(start), start);
      reserveSearchBudget(store, 2, "tavily", id(start), start);
      expect(() => reserveSearchBudget(store, 3, "tavily", id(start), start)).toThrow(/concurrency/);
      expect(() => reserveSearchBudget(store, 1, "firecrawl", id(start), start)).not.toThrow();
    });
    await ledger(store => expect(() => reserveSearchBudget(store, 1, "tavily", id(start), start)).not.toThrow());
  });

  it("enforces a rolling minute, retaining sent and expired counts", async () => {
    await ledger(store => {
      for (let i = 0; i < 10; i++) {
        const request = id(start);
        reserveSearchBudget(store, i, "tavily", request, start);
        settleSearchBudget(store, i, request, "sent-or-unknown", start);
      }
      expect(() => reserveSearchBudget(store, 11, "tavily", id(start + 59_999), start + 59_999)).toThrow(/rate limit/);
      expect(() => reserveSearchBudget(store, 11, "tavily", id(start + 60_000), start + 60_000)).not.toThrow();
    });
  });

  it("does not reset the daily count when connections change or tombstones are pruned", async () => {
    await ledger(store => {
      for (let i = 0; i < 100; i++) {
        const now = start + i * 61_000;
        const request = id(now);
        reserveSearchBudget(store, i, "tavily", request, now);
        settleSearchBudget(store, i, request, "sent-or-unknown", now);
      }
      const now = start + 101 * 61_000;
      expect(() => reserveSearchBudget(store, 999, "tavily", id(now), now)).toThrow(/daily limit/);
      expect(() => reserveSearchBudget(store, 999, "firecrawl", id(now), now)).not.toThrow();
      const tomorrow = start + 86_400_000;
      expect(() => reserveSearchBudget(store, 999, "tavily", id(tomorrow), tomorrow)).not.toThrow();
    });
  });

  it("refunds only once, rejects foreign settlement and refuses finalized replay", async () => {
    await ledger(store => {
      const request = id(start);
      const lease = reserveSearchBudget(store, 1, "tavily", request, start);
      expect(reserveSearchBudget(store, 1, "tavily", request, start + 1)).toEqual(lease);
      expect(() => reserveSearchBudget(store, 2, "tavily", request, start)).toThrow(/Foreign/);
      expect(() => settleSearchBudget(store, 2, request, "not-dispatched", start)).toThrow(/Foreign/);
      settleSearchBudget(store, 1, request, "not-dispatched", start);
      settleSearchBudget(store, 1, request, "not-dispatched", start);
      expect(() => reserveSearchBudget(store, 1, "tavily", request, start)).toThrow(/already ended/);
      expect(store.get<{ counts: { tavily: number } }>("searchBudget.v1")?.counts.tavily).toBe(0);
    });
  });

  it("releases expired concurrency without refund and rejects replay after record cleanup", async () => {
    await ledger(store => {
      const request = id(start);
      reserveSearchBudget(store, 1, "tavily", request, start);
      settleSearchBudget(store, 1, request, "not-dispatched", start + 60_000);
      expect(store.get<{ counts: { tavily: number } }>("searchBudget.v1")?.counts.tavily).toBe(1);
      reserveSearchBudget(store, 1, "tavily", id(start + 180_001), start + 180_001);
      expect(() => reserveSearchBudget(store, 1, "tavily", request, start + 180_001)).toThrow(/expired/);
      settleSearchBudget(store, 1, request, "not-dispatched", start + 180_001);
      expect(store.get<{ counts: { tavily: number } }>("searchBudget.v1")?.counts.tavily).toBe(2);
    });
  });

  it("preserves in-flight concurrency at midnight and never refunds the new day's count", async () => {
    await ledger(store => {
      const midnight = Date.parse("2026-09-22T00:00:00Z");
      const old = id(midnight - 1000);
      reserveSearchBudget(store, 1, "tavily", old, midnight - 1000);
      reserveSearchBudget(store, 2, "tavily", id(midnight - 1000), midnight - 1000);
      expect(() => reserveSearchBudget(store, 3, "tavily", id(midnight), midnight)).toThrow(/concurrency/);
      settleSearchBudget(store, 1, old, "not-dispatched", midnight);
      reserveSearchBudget(store, 3, "tavily", id(midnight), midnight);
      settleSearchBudget(store, 1, old, "not-dispatched", midnight + 1);
      expect(store.get<{ counts: { tavily: number } }>("searchBudget.v1")?.counts.tavily).toBe(1);
    });
  });

  it("bounds refunded tombstones without admitting stale or future ids", async () => {
    await ledger(store => {
      for (let i = 0; i < 128; i++) {
        const request = id(start);
        reserveSearchBudget(store, 1, "tavily", request, start);
        settleSearchBudget(store, 1, request, "not-dispatched", start);
      }
      expect(() => reserveSearchBudget(store, 1, "tavily", id(start), start)).toThrow(/capacity/);
      expect(() => reserveSearchBudget(store, 1, "tavily", id(start + 10_000), start)).toThrow(/expired/);
      expect(() => reserveSearchBudget(store, 1, "tavily", "invalid", start)).toThrow(/Invalid/);
      expect(() => reserveSearchBudget(store, 1, "tavily", id(start + 180_001), start + 180_001)).not.toThrow();
    });
  });

  it("does not reset a bucket when the clock moves backwards", async () => {
    await ledger(store => {
      reserveSearchBudget(store, 1, "tavily", id(start), start);
      reserveSearchBudget(store, 2, "tavily", id(start), start);
      expect(() => reserveSearchBudget(store, 3, "tavily", id(start), start - 86_400_000)).toThrow(/concurrency/);
      settleSearchBudget(store, 1, id(start), "not-dispatched", start);
      expect(store.get<{ counts: { tavily: number } }>("searchBudget.v1")?.counts.tavily).toBe(2);
    });
  });
});
}
