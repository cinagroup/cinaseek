import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";

function requestId() { return `${Date.now()}:${crypto.randomUUID()}`; }
function connection() { return env.TEST_SEARCH_BUDGET.getByName(crypto.randomUUID()); }
function userStub(userId: string) { return env.TEST_USER.get(env.TEST_USER.idFromString(userId)); }

// Do not let assertion introspection operate on RPC proxies, or keep the result's pipeline
// alive across eviction. Only the copied reservation value escapes this helper.
async function reserve(hook: ReturnType<typeof connection>, provider: "tavily" | "firecrawl", id: string) {
  using result = await hook.reserve(provider, id);
  return { expiresAt: result.expiresAt };
}

// Account credentials and providers are fixtures, but every budget/callback/storage hop is real
// Workers RPC. No global fetch or provider token is used anywhere in this suite.
describe("personal search budget capability and User DO RPC", { timeout: 60_000 }, () => {
  it("admits only two concurrent reservations across one user's connections", async () => {
    const owner = crypto.randomUUID();
    const a = connection();
    const b = connection();
    await Promise.all([a.installAccount(owner, 1), b.installAccount(owner, 2)]);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      reserve(i % 2 ? a : b, "tavily", requestId())));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    for (const result of results) {
      if (result.status === "rejected") expect(String(result.reason)).toContain("concurrency");
    }
    await expect(reserve(b, "firecrawl", requestId())).resolves.toHaveProperty("expiresAt");
    const other = connection();
    await other.installAccount(crypto.randomUUID(), 1);
    await expect(reserve(other, "tavily", requestId())).resolves.toHaveProperty("expiresAt");
  });

  it("preserves budget Fetchers and active leases across account and user DO eviction", async () => {
    const hook = connection();
    const userId = await hook.installAccount(crypto.randomUUID(), 1);
    const first = requestId();
    const lease = await reserve(hook, "tavily", first);
    await reserve(hook, "tavily", requestId());
    await evictDurableObject(hook);
    await evictDurableObject(userStub(userId));
    expect(await reserve(hook, "tavily", first)).toEqual(lease);
    await expect(reserve(hook, "tavily", requestId())).rejects.toThrow(/concurrency/);
    await hook.settle(first, "sent-or-unknown");
    await expect(reserve(hook, "tavily", requestId())).resolves.toHaveProperty("expiresAt");
  });

  it("revokes new reservations on disconnect but allows the old capability to settle its lease", async () => {
    const owner = crypto.randomUUID();
    const old = connection();
    await old.installAccount(owner, 1);
    const first = requestId();
    await reserve(old, "tavily", first);
    await old.disconnect();
    await expect(reserve(old, "tavily", requestId())).rejects.toThrow(/unavailable/);
    await old.settle(first, "sent-or-unknown");
    const added = connection();
    await added.installAccount(owner, 2);
    for (let i = 0; i < 9; i++) {
      const next = requestId();
      await reserve(added, "tavily", next);
      await added.settle(next, "sent-or-unknown");
    }
    await expect(reserve(added, "tavily", requestId())).rejects.toThrow(/rate limit/);
    await expect(reserve(old, "tavily", requestId())).rejects.toThrow(/unavailable/);
  });

  it("keeps counts through credentials expiry and reconnection", async () => {
    const hook = connection();
    await hook.installAccount(crypto.randomUUID(), 1);
    for (let i = 0; i < 10; i++) {
      const next = requestId();
      await reserve(hook, "tavily", next);
      await hook.settle(next, "sent-or-unknown");
    }
    await hook.expire();
    await expect(reserve(hook, "tavily", requestId())).rejects.toThrow(/unavailable/);
    await hook.reconnect();
    await hook.restore();
    await expect(reserve(hook, "tavily", requestId())).rejects.toThrow(/rate limit/);
  });

  it("rejects foreign settlements, cross-provider request reuse and unsupported vendors", async () => {
    const owner = crypto.randomUUID();
    const a = connection();
    const b = connection();
    await Promise.all([a.installAccount(owner, 1), b.installAccount(owner, 2)]);
    const first = requestId();
    await reserve(a, "tavily", first);
    await expect(Promise.resolve(b.settle(first, "not-dispatched"))).rejects.toThrow(/Foreign/);
    await expect(reserve(a, "firecrawl", first)).rejects.toThrow(/Foreign/);
    await reserve(b, "tavily", requestId());
    await expect(reserve(b, "tavily", requestId())).rejects.toThrow(/concurrency/);
    const foreign = connection();
    await foreign.installAccount(crypto.randomUUID(), 1, "other");
    await expect(reserve(foreign, "tavily", requestId())).rejects.toThrow(/not available/);
  });

  it("does not regain a daily budget after eviction and reconnect", async () => {
    const hook = connection();
    const userId = await hook.installAccount(crypto.randomUUID(), 1);
    // Seed only the clock-intensive daily boundary; all admission/settlement is real RPC.
    await runInDurableObject(userStub(userId), (_user, ctx) => {
      ctx.storage.kv.put("searchBudget.v1", {
        now: Date.now(), day: new Date().toISOString().slice(0, 10),
        counts: { tavily: 100, firecrawl: 0 }, records: [],
      });
    });
    await evictDurableObject(userStub(userId));
    await hook.reconnect();
    await expect(reserve(hook, "tavily", requestId())).rejects.toThrow(/daily limit/);
    await expect(reserve(hook, "firecrawl", requestId())).resolves.toHaveProperty("expiresAt");
  });
});
