import type {
  GatekeeperSearchProvider, GatekeeperSearchReservation,
} from "@gadgets/workshop-shared/gatekeeper";

const KEY = "searchBudget.v1";
const MINUTE = 60_000;
const ID_MAX_AGE = 2 * MINUTE;
const RETENTION = 3 * MINUTE;
const MAX_RECORDS = 128;

type Reservation = {
  id: string;
  accountId: number;
  provider: GatekeeperSearchProvider;
  createdAt: number;
  expiresAt: number;
  state: "active" | "consumed" | "released";
};
type State = {
  now: number;
  day: string;
  counts: Record<GatekeeperSearchProvider, number>;
  records: Reservation[];
};
type Store = Pick<SyncKvStorage, "get" | "put">;

function read(store: Store, clock: number): State {
  const stored = store.get<State>(KEY);
  const now = Math.max(clock, stored?.now ?? 0);
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    now, day,
    counts: stored?.day === day ? { ...stored.counts } : { tavily: 0, firecrawl: 0 },
    // Retain finalized tombstones past the id's admissible lifetime. A purged id is too old to
    // reserve again, even after a DO restart. Active leases live only 60 seconds.
    records: (stored?.records ?? []).filter(record => record.createdAt + RETENTION > now)
      .map(record => ({ ...record })),
  };
}

function validateId(id: string, now: number): void {
  if (typeof id !== "string" || !/^\d{13}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error("Invalid search reservation id.");
  }
  const issuedAt = Number(id.slice(0, 13));
  if (issuedAt > now + 5_000 || now - issuedAt > ID_MAX_AGE) {
    throw new Error("Search reservation id expired. Start a new request.");
  }
}

/** Atomically reserves inside a user DO: no await or external I/O between the read and write. */
export function reserveSearchBudget(
  store: Store, accountId: number, provider: GatekeeperSearchProvider, id: string, clock = Date.now(),
): GatekeeperSearchReservation {
  if (provider !== "tavily" && provider !== "firecrawl") throw new Error("Unsupported search provider.");
  const state = read(store, clock);
  validateId(id, state.now);
  const prior = state.records.find(record => record.id === id);
  if (prior) {
    if (prior.accountId !== accountId || prior.provider !== provider) throw new Error("Foreign search reservation.");
    if (prior.state !== "active" || prior.expiresAt <= state.now) throw new Error("Search reservation already ended.");
    return { expiresAt: prior.expiresAt };
  }
  const records = state.records.filter(record => record.provider === provider);
  if (records.filter(record => record.state === "active" && record.expiresAt > state.now).length >= 2) {
    throw new Error("Search concurrency limit reached (2 per provider). Try later.");
  }
  if (records.filter(record => record.state !== "released" && record.createdAt > state.now - MINUTE).length >= 10) {
    throw new Error("Search rate limit reached (10 per 60 seconds). Try later.");
  }
  if (state.counts[provider] >= 100) throw new Error("Search daily limit reached (100 per provider, resets at UTC midnight).");
  if (records.length >= MAX_RECORDS) throw new Error("Search reservation capacity reached. Try later.");
  const expiresAt = state.now + MINUTE;
  state.records.push({ id, accountId, provider, createdAt: state.now, expiresAt, state: "active" });
  state.counts[provider]++;
  store.put(KEY, state);
  return { expiresAt };
}

/** Settles only the owning connection's active lease; uncertain/expired calls never refund. */
export function settleSearchBudget(
  store: Store, accountId: number, id: string,
  outcome: "not-dispatched" | "sent-or-unknown", clock = Date.now(),
): void {
  if (outcome !== "not-dispatched" && outcome !== "sent-or-unknown") throw new Error("Invalid search settlement.");
  const state = read(store, clock);
  const record = state.records.find(item => item.id === id);
  if (!record) return; // Pruned/unknown ids must not affect counters.
  if (record.accountId !== accountId) throw new Error("Foreign search reservation.");
  if (record.state !== "active") return;
  const refund = outcome === "not-dispatched" && record.expiresAt > state.now;
  record.state = refund ? "released" : "consumed";
  if (refund && new Date(record.createdAt).toISOString().slice(0, 10) === state.day) {
    state.counts[record.provider] = Math.max(0, state.counts[record.provider] - 1);
  }
  store.put(KEY, state);
}
