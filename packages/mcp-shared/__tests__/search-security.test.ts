import { afterEach, describe, expect, it, vi } from "vitest";
import { withClient, type ConnectionAccount } from "../src/connection.js";
import { McpCallNotDispatchedError, type McpWireTool } from "../src/client.js";
import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { SEARCH_PRESETS } from "../src/search-presets.js";
import { classifyTool } from "../src/tools.js";
import { storedSearchBudget } from "./search-budget-fixture.js";

const [tavily] = SEARCH_PRESETS;

function wireTool(name: string, readOnly = true) {
  return {
    name, annotations: { readOnlyHint: readOnly },
    inputSchema: { type: "object", required: ["query"], properties: {
      query: { type: "string" }, limit: { type: "number" }, max_results: { type: "number" },
      search_depth: { type: "string", enum: ["basic", "advanced"] },
    } },
  } satisfies McpWireTool;
}

function connection(token = "test-personal-token"): ConnectionAccount {
  return {
    async getConnection() { return { authorization: token, sessionId: "session", generation: 1,
      searchBudget: storedSearchBudget() }; },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    noteCredentialsExpired: vi.fn(async () => {}),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.each(SEARCH_PRESETS)("$name personal credentials", preset => {
  it.each([402, 429, 500])("does not retry or change credentials after HTTP %s", async status => {
    const account = connection();
    const sent: { method: string; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push({ method: body.method, authorization: new Headers(init.headers).get("Authorization") });
      return body.method === "tools/list"
        ? Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [wireTool(preset.tool)] } })
        : new Response(null, { status });
    });
    await expect(withClient({}, account, preset.endpoint,
      client => client.callTool(preset.tool, { query: "test" }))).rejects.toThrow(`HTTP ${status}`);
    expect(sent.map(call => call.method)).toEqual(["tools/list", "tools/call"]);
    expect(sent.every(call => call.authorization === "Bearer test-personal-token")).toBe(true);
    expect(account.noteCredentialsExpired).not.toHaveBeenCalled();
  });

  it("keeps separate accounts' credentials isolated during concurrent searches", async () => {
    const seen = new Map<string, string | null>();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [wireTool(preset.tool)] } });
      }
      seen.set(body.params.arguments.query, new Headers(init.headers).get("Authorization"));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
    });
    await Promise.all(["alice", "bob"].map(owner => withClient({}, connection(`test-${owner}`),
      preset.endpoint, client => client.callTool(preset.tool, { query: owner }))));
    expect([...seen.entries()].toSorted()).toEqual([
      ["alice", "Bearer test-alice"], ["bob", "Bearer test-bob"],
    ]);
  });

  it("rejects a connection invalidated between discovery and execution", async () => {
    const account = connection();
    account.assertConnectionCurrent = async () => { throw new Error("Connection was disconnected."); };
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      methods.push(body.method);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [wireTool(preset.tool)] } });
    });
    await expect(withClient({}, account, preset.endpoint,
      client => client.callTool(preset.tool, { query: "test" }))).rejects.toBeInstanceOf(McpCallNotDispatchedError);
    expect(methods).toEqual(["tools/list"]);
  });

  it("marks a discovery-time credential rejection expired without executing a search", async () => {
    const account = connection();
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(withClient({}, account, preset.endpoint,
      client => client.callTool(preset.tool, { query: "test" }))).rejects.toThrow(/reconnect/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(account.noteCredentialsExpired).toHaveBeenCalledOnce();
  });
});

function sessionHost(readOnly: boolean): McpSessionHost {
  const entry = classifyTool(wireTool(tavily.tool, readOnly), "byo");
  let action: StoredAction | undefined;
  return {
    serverName: "Tavily", endpoint: tavily.endpoint, scope: { tools: [tavily.tool] },
    async tools() { return [entry]; },
    async searchTools() { return [entry]; },
    async findTool(name) { return name === tavily.tool ? entry : undefined; },
    call: (fn, options) => withClient({}, connection(), tavily.endpoint, fn, options),
    actionKindFor: name => ({ tag: `test:${name}`, label: name }),
    stageAction(toolName, args) {
      action = { id: 1, toolName, args, state: "pending", submittedAt: Date.now() };
      return action;
    },
    discardStagedAction() { action = undefined; },
    lookupAction: () => action,
  };
}

describe("search observation and approval boundary", () => {
  it("does not release search results when observation authorization fails", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body.method);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list"
        ? { tools: [wireTool(tavily.tool)] } : { content: [{ type: "text", text: "private result" }] } });
    });
    const authorizeObservation = vi.fn(async () => { throw new Error("Observation denied."); });
    const session = new McpSessionBase(sessionHost(true), { authorizeObservation } as never);
    await expect(session.callTool(tavily.tool, { query: "test" })).rejects.toThrow("Observation denied.");
    expect(authorizeObservation).toHaveBeenCalledOnce();
    expect(sent).toEqual(["tools/list", "tools/call"]);
  });

  it("keeps untrusted non-read-only searches queued without dispatch or automatic approval", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const submitAction = vi.fn(async () => {});
    const host = sessionHost(false);
    const session = new McpSessionBase(host, { submitAction } as never);
    await expect(session.callTool(tavily.tool, { query: "test" })).resolves.toMatchObject({ status: "pending" });
    expect(submitAction).toHaveBeenCalledWith(1, expect.objectContaining({
      awaitDecision: true, autoApprovable: false,
    }));
    expect(host.lookupAction(1)?.args).toEqual({ query: "test", max_results: 5, search_depth: "basic" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses high-cost options before staging an approval", async () => {
    const submitAction = vi.fn();
    const host = sessionHost(false);
    const session = new McpSessionBase(host, { submitAction } as never);
    await expect(session.callTool(tavily.tool, { query: "test", search_depth: "advanced" })).rejects.toThrow();
    expect(host.lookupAction(1)).toBeUndefined();
    expect(submitAction).not.toHaveBeenCalled();
  });
});
