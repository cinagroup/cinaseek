// Test-only wrapper: production entrypoints are unchanged, and no test hook is deployed.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription, GatekeeperUser, GatekeeperSearchBudget, GatekeeperSearchProvider,
} from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../src/server.js";
export * from "../src/server.js";

/** Credential-free account fixture for exercising the real Workshop connection lifecycle. */
export class SearchBudgetTestAccount extends WorkerEntrypoint<Cloudflare.Env, { label: string }>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { uniqueName: this.ctx.props.label, avatar: { url: "https://example.invalid/avatar" } };
  }
  async getSupportedResources() { return []; }
  async getGatekeeperClassFor(): Promise<never> { throw new Error("No test resources"); }
  async startResourceConfigurator(): Promise<never> { throw new Error("No test UI"); }
  async getVerifier(): Promise<never> { throw new Error("No test observers"); }
  async ensureResources() { return {}; }
  async getAuthenticatedEmail() { return null; }
  async revoke() {}
  async reconnect() { return { url: "https://example.invalid/reconnect" }; }
}

/** Persists a real budget Fetcher in another DO, just as the MCP account does in production. */
export class SearchBudgetTestHooks extends DurableObject<Cloudflare.Env> {
  async installAccount(owner: string, accountId: number, vendorId = "mcp") {
    const user = this.ctx.exports.UserDurableObject.getByName(owner);
    const props = { userId: user.id.toString(), accountId, vendorId };
    // Generated production types intentionally exclude test-only exports. Derive the loopback
    // from the actual class instead of mirroring its RPC interface or weakening it to `any`.
    const testExports = this.ctx.exports as typeof this.ctx.exports & {
      SearchBudgetTestAccount: LoopbackForExport<typeof SearchBudgetTestAccount>;
    };
    const account = testExports.SearchBudgetTestAccount({ props: { label: `${owner}:${accountId}` } });
    await this.ctx.exports.GatekeeperConnectCallbackImpl({ props }).complete(account);
    this.ctx.storage.kv.put("owner", props.userId);
    this.ctx.storage.kv.put("accountId", accountId);
    this.ctx.storage.kv.put("budget", this.ctx.exports.GatekeeperSearchBudgetImpl({ props }));
    return props.userId;
  }

  #budget() {
    const budget = this.ctx.storage.kv.get<Fetcher<GatekeeperSearchBudget>>("budget");
    if (!budget) throw new Error("Test connection not installed");
    return budget;
  }

  #user() {
    const owner = this.ctx.storage.kv.get<string>("owner");
    if (!owner) throw new Error("Test connection not installed");
    return this.ctx.exports.UserDurableObject.get(this.ctx.exports.UserDurableObject.idFromString(owner));
  }

  #accountId() {
    const accountId = this.ctx.storage.kv.get<number>("accountId");
    if (accountId === undefined) throw new Error("Test connection not installed");
    return accountId;
  }

  async reserve(provider: GatekeeperSearchProvider, requestId: string) {
    return this.#budget().reserve(provider, requestId);
  }

  async settle(requestId: string, outcome: "not-dispatched" | "sent-or-unknown") {
    return this.#budget().settle(requestId, outcome);
  }

  async expire() { await this.#user().markCredentialsExpired(this.#accountId()); }
  async restore() { await this.#user().markCredentialsRestored(this.#accountId()); }
  async reconnect() { return this.#user().reconnectAccount(this.#accountId()); }
  async disconnect() { await this.#user().disconnectAccount(this.#accountId()); }
}
