import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpCallNotDispatchedError, type McpWireTool } from "../src/client.js";
import { withClient, type ConnectionAccount } from "../src/connection.js";
import { scopedCatalog, type CatalogStore } from "../src/catalog.js";
import { searchBudget, storedSearchBudget } from "./search-budget-fixture.js";
import {
  SEARCH_PRESETS, prepareSearchArguments, restrictSearchScope,
  searchPresetForEndpoint, searchToolForEndpoint,
} from "../src/search-presets.js";

const [tavily, firecrawl] = SEARCH_PRESETS;
const tool: McpWireTool = {
  name: tavily.tool,
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object", required: ["query"], properties: {
      query: { type: "string" }, max_results: { type: "number" },
      search_depth: { type: "string", enum: ["basic", "advanced"] },
      include_domains: { type: "array" },
      include_raw_content: { type: "boolean" },
    },
  },
};
const account: ConnectionAccount = {
  async getConnection() { return { authorization: "test-personal-token", sessionId: "session", generation: 1,
    searchBudget: storedSearchBudget() }; },
  async assertConnectionCurrent() {},
  async setMcpSessionId() { return true; },
  async noteCredentialsExpired() {},
};

afterEach(() => vi.unstubAllGlobals());

describe("search endpoint identity", () => {
  it("recognizes canonical endpoints and a single trailing slash", () => {
    for (const preset of SEARCH_PRESETS) {
      expect(searchPresetForEndpoint(preset.endpoint)).toEqual(preset);
      expect(searchPresetForEndpoint(`${preset.endpoint}/`)).toEqual(preset);
    }
    expect(searchPresetForEndpoint("https://mcp.example.com/mcp")).toBeUndefined();
  });

  it.each([
    "https://mcp.tavily.com/mcp?tavilyApiKey=test-secret",
    "https://mcp.tavily.com/mcp?unrecognized=1",
    "https://mcp.tavily.com/mcp#tool=tavily_crawl",
    "https://mcp.tavily.com/mcp//",
    "https://mcp.tavily.com./mcp",
    "https://mcp.tavily.com:444/mcp",
    "http://mcp.tavily.com/mcp",
    "https://user:password@mcp.tavily.com/mcp",
    "https://mcp.firecrawl.dev/v2/mcp",
    "https://mcp.firecrawl.dev/other",
  ])("rejects a known-host variant without echoing credentials: %s", endpoint => {
    expect(() => searchPresetForEndpoint(endpoint)).toThrow(/personal OAuth endpoint/);
    try { searchPresetForEndpoint(endpoint); } catch (error) {
      expect(String(error)).not.toContain("test-secret");
      expect(String(error)).not.toContain("password");
    }
  });
});

describe("bounded grants and parameters", () => {
  it("pins bare endpoints and preserves explicit empty grants", () => {
    expect(restrictSearchScope(tavily.endpoint, {})).toEqual({ tools: [tavily.tool] });
    expect(restrictSearchScope(tavily.endpoint, { tools: [] })).toEqual({ tools: [] });
    expect(() => restrictSearchScope(tavily.endpoint, { tools: ["tavily_crawl"] })).toThrow();
    expect(() => restrictSearchScope(tavily.endpoint, { serverId: "tavily" })).toThrow();
  });

  it("defaults to basic search with five results", () => {
    expect(prepareSearchArguments(tavily.endpoint, tavily.tool, { query: "test" }))
      .toEqual({ query: "test", search_depth: "basic", max_results: 5 });
    expect(prepareSearchArguments(firecrawl.endpoint, firecrawl.tool, { query: "test" }))
      .toEqual({ query: "test", limit: 5 });
  });

  it.each<Record<string, unknown>>([
    { query: "test", search_depth: "advanced" },
    { query: "test", auto_parameters: true },
    { query: "test", include_raw_content: true },
    { query: "test", max_results: 11 },
    { query: "test", max_results: 1.5 },
    { query: "test", max_results: "5" },
    { query: "test", max_results: null },
    { query: "test", include_domains: ["https://example.com"] },
    { query: "test", include_domains: Array(11).fill("example.com") },
    { query: "test", constructor: "unexpected" },
    { query: " " },
    { query: "x".repeat(2001) },
  ])("rejects unsupported Tavily arguments before dispatch", args => {
    expect(() => prepareSearchArguments(tavily.endpoint, tavily.tool, args)).toThrow();
  });

  it.each([
    { scrapeOptions: { formats: ["json"] } },
    { sources: [{ type: "web" }, { type: "news" }] },
    { enterprise: ["zdr"] },
    { includeDomains: ["example.com"], excludeDomains: ["example.org"] },
  ])("rejects Firecrawl cost multipliers and conflicting domains", args => {
    expect(() => prepareSearchArguments(firecrawl.endpoint, firecrawl.tool, { query: "test", ...args }))
      .toThrow();
  });

  it("keeps scrape unavailable while parser suppression is unverified", () => {
    expect(() => prepareSearchArguments(firecrawl.endpoint, "firecrawl_scrape", { url: "https://example.com" }))
      .toThrow(/search only/);
  });

  it("does not change other MCP providers", () => {
    const args = { anything: { nested: true } };
    expect(prepareSearchArguments("https://mcp.example.com", "anything", args)).toBe(args);
    expect(searchToolForEndpoint("https://mcp.example.com", tool)).toBe(tool);
  });
});

describe("catalog and dispatch enforcement", () => {
  it("ignores an unrestricted catalog persisted before search presets", async () => {
    const values = new Map<string, unknown>([["catalog", {
      fetchedAt: Date.now(), revision: "old", tools: [tool, { ...tool, name: "tavily_crawl" }],
    }]]);
    const store: CatalogStore = {
      get<T>(key: string) { return values.get(key) as T | undefined; },
      put<T>(key: string, value: T) { values.set(key, value); },
    };
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [tool] } });
    });
    vi.stubGlobal("fetch", fetch);
    const request = { store, log: { info: vi.fn(), warn: vi.fn() } as never,
      env: {}, account, endpoint: tavily.endpoint, scope: { tools: [tavily.tool] }, trust: "byo" as const };
    const catalog = await scopedCatalog(request);
    expect(catalog.tools.map(entry => entry.tool.name)).toEqual([tavily.tool]);
    expect(catalog.tools[0].tool.inputSchema?.properties).not.toHaveProperty("include_raw_content");
    expect(fetch).toHaveBeenCalledOnce();
    await scopedCatalog(request);
    expect(fetch).toHaveBeenCalledOnce();
    expect(values.has("catalog.search-v1")).toBe(true);
  });

  it("narrows the advertised schema without changing trust annotations", () => {
    const narrowed = searchToolForEndpoint(tavily.endpoint, tool);
    expect(narrowed?.inputSchema.properties).not.toHaveProperty("include_raw_content");
    expect(narrowed?.inputSchema.properties?.search_depth).toMatchObject({ enum: ["basic"] });
    expect(narrowed?.annotations).toEqual(tool.annotations);
    expect(searchToolForEndpoint(tavily.endpoint, { ...tool, name: "tavily_crawl" })).toBeUndefined();
  });

  it("fails closed on missing or incompatible schemas", () => {
    expect(() => searchToolForEndpoint(tavily.endpoint, {
      ...tool, inputSchema: { type: "object", properties: { query: { type: "string" } } },
    })).toThrow(/schema changed/);
    expect(() => searchToolForEndpoint(tavily.endpoint, {
      ...tool, inputSchema: { ...tool.inputSchema, required: ["query", "api_key"] },
    })).toThrow(/unsupported/);
    expect(() => searchToolForEndpoint(tavily.endpoint, {
      ...tool, inputSchema: { ...tool.inputSchema, properties: {
        ...tool.inputSchema.properties, include_domains: { type: "string" },
      } },
    })).toThrow(/schema changed/);
  });

  it("checks the live catalog and bounds arguments even for direct/queued tool execution", async () => {
    const sent: { method: string; params: unknown }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list"
        ? { tools: [tool, { ...tool, name: "tavily_crawl" }] }
        : { content: [{ type: "text", text: "ok" }] } });
    });
    const client = new McpClient(tavily.endpoint, async () => "test-token", "session", {}, searchBudget());
    expect((await client.listTools(10)).tools.map(item => item.name)).toEqual([tavily.tool]);
    await client.callTool(tavily.tool, { query: "test" });
    expect(sent.at(-1)).toMatchObject({ method: "tools/call", params: {
      name: tavily.tool, arguments: { query: "test", search_depth: "basic", max_results: 5 },
    } });
    const count = sent.length;
    await expect(client.callTool("tavily_crawl", {})).rejects.toBeInstanceOf(McpCallNotDispatchedError);
    await expect(client.callTool(tavily.tool, { query: "test", max_results: 999 })).rejects.toThrow();
    expect(sent).toHaveLength(count);
  });

  it("does not dispatch against a missing live tool", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      methods.push(body.method);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    });
    const client = new McpClient(tavily.endpoint, async () => "test-token", "session", {}, searchBudget());
    await expect(client.callTool(tavily.tool, { query: "test" })).rejects.toThrow(/no longer supports/);
    expect(methods).toEqual(["tools/list"]);
  });

  it("refuses anonymous credentials without outbound requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(withClient({}, {
      ...account,
      async getConnection() { return { authorization: null, sessionId: "session", generation: 1 }; },
    }, tavily.endpoint, client => client.callTool(tavily.tool, { query: "test" })))
      .rejects.toThrow(/requires OAuth/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry a potentially billed search on session expiry", async () => {
    let calls = 0;
    const updates: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [tool] } });
      }
      calls++;
      return new Response(null, { status: 404 });
    });
    await expect(withClient({}, {
      ...account,
      async setMcpSessionId(_endpoint, _generation, _previous, next) { updates.push(next); return true; },
    }, tavily.endpoint, client => client.callTool(tavily.tool, { query: "test" }))).rejects.toThrow();
    expect(calls).toBe(1);
    expect(updates).toEqual([null]);
  });

  it("clears an expired transport session during live-catalog verification", async () => {
    const methods: string[] = [];
    const updates: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      methods.push(JSON.parse(String(init.body)).method);
      return new Response(null, { status: 404 });
    });
    await expect(withClient({}, {
      ...account,
      async setMcpSessionId(_endpoint, _generation, _previous, next) { updates.push(next); return true; },
    }, tavily.endpoint, client => client.callTool(tavily.tool, { query: "test" }))).rejects.toThrow();
    expect(methods).toEqual(["tools/list"]);
    expect(updates).toEqual([null]);
  });

  it.each(["application/json", "text/event-stream"])("caps %s tool responses at 256 KiB", async contentType => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [tool] } });
      }
      const result = JSON.stringify({ jsonrpc: "2.0", id: body.id,
        result: { content: [{ type: "text", text: "x".repeat(256 * 1024) }] } });
      return new Response(contentType === "application/json" ? result : `data: ${result}\n\n`,
        { headers: { "Content-Type": contentType } });
    });
    const client = new McpClient(tavily.endpoint, async () => "test-token", "session", {}, searchBudget());
    await expect(client.callTool(tavily.tool, { query: "test" })).rejects.toThrow(/262144/);
  });
});
