import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpCallNotDispatchedError, type McpWireTool } from "../src/client.js";
import { prepareSearchArguments, SEARCH_PRESETS, searchToolForEndpoint } from "../src/search-presets.js";
import { searchBudget } from "./search-budget-fixture.js";
import { tavilyRemoteSearch } from "./tavily-remote-search-fixture.js";

const [tavily, firecrawl] = SEARCH_PRESETS;
type WireProperty = NonNullable<McpWireTool["inputSchema"]["properties"]>[string];

function withProperty(key: string, schema: WireProperty): McpWireTool {
  return { ...tavilyRemoteSearch, inputSchema: {
    ...tavilyRemoteSearch.inputSchema,
    properties: { ...tavilyRemoteSearch.inputSchema.properties, [key]: schema },
  } };
}

afterEach(() => vi.unstubAllGlobals());

describe("remote Tavily schema compatibility", () => {
  it("accepts the observed remote nullable time_range and const topic, keeping a bounded non-null API", () => {
    const narrowed = searchToolForEndpoint(tavily.endpoint, tavilyRemoteSearch);
    expect(narrowed?.inputSchema).toEqual({
      type: "object", required: ["query"], additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2000 },
        max_results: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        search_depth: { type: "string", enum: ["basic"], default: "basic" },
        topic: { type: "string", enum: ["general"] },
        time_range: { type: "string", enum: ["day", "week", "month", "year"] },
        include_domains: { type: "array", maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 253 } },
        exclude_domains: { type: "array", maxItems: 10,
          items: { type: "string", minLength: 1, maxLength: 253 } },
      },
    });
    expect(narrowed?.annotations).toBeUndefined();
  });

  it("accepts either nullable branch order and a basic-only const", () => {
    expect(searchToolForEndpoint(tavily.endpoint, withProperty("time_range", {
      anyOf: [{ type: "null" }, { type: "string", enum: ["day", "week", "month", "year"] }],
    }))?.inputSchema.properties?.time_range).toMatchObject({ type: "string" });
    expect(searchToolForEndpoint(tavily.endpoint,
      withProperty("search_depth", { type: "string", const: "basic" }))
      ?.inputSchema.properties?.search_depth).toMatchObject({ enum: ["basic"] });
  });

  it.each<[string, WireProperty]>([
    ["topic", { type: "string", const: "news" }],
    ["topic", { type: "string", const: "news", enum: ["general", "news"] }],
    ["search_depth", { type: "string", const: "advanced", enum: ["basic", "advanced"] }],
    ["time_range", { type: "string", enum: "day" }],
    ["time_range", { anyOf: [{ type: "string", enum: ["day"] }, { type: "null" }] }],
    ["time_range", { anyOf: [{ type: "integer" }, { type: "null" }] }],
    ["time_range", { anyOf: [{ type: "string" }, { type: "boolean" }] }],
    ["time_range", { anyOf: [{ type: "string" }, { type: "null" }, { type: "number" }] }],
    ["time_range", { anyOf: [{ type: "string" }, { type: "null", const: "day" }] }],
    ["time_range", { anyOf: [{ type: "string" }, { type: "null" }], const: "day" }],
    ["time_range", { anyOf: [{ type: "string", $ref: "#/$defs/range" }, { type: "null" }] }],
    ["time_range", { anyOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }, { type: "null" }] }],
    ["time_range", { type: "string", allOf: [{ const: "day" }] }],
    ["time_range", { type: ["string", "null"] }],
    ["time_range", { oneOf: [{ type: "string" }, { type: "null" }] }],
  ])("fails closed for incompatible or unreviewed %s schema: %j", (key, schema) => {
    expect(() => searchToolForEndpoint(tavily.endpoint, withProperty(key, schema))).toThrow(/schema changed/);
  });

  it("does not echo upstream schema contents into diagnostic errors", () => {
    expect(() => searchToolForEndpoint(tavily.endpoint,
      withProperty("time_range", { type: "secret-marker", description: "private upstream content" })))
      .toThrow("Tavily search schema changed for time_range; reconnect after compatibility is reviewed.");
  });

  it.each([
    { time_range: null }, { search_depth: "advanced" }, { topic: "news" },
    { include_raw_content: true }, { exact_match: true }, { max_results: 11 },
  ])("does not expand accepted caller arguments: %j", args => {
    expect(() => prepareSearchArguments(tavily.endpoint, tavily.tool, { query: "test", ...args })).toThrow();
  });

  it("keeps the existing Firecrawl contract working", () => {
    const tool: McpWireTool = { name: firecrawl.tool, inputSchema: {
      type: "object", required: ["query"], properties: {
        query: { type: "string" }, limit: { type: "number" },
      },
    } };
    expect(searchToolForEndpoint(firecrawl.endpoint, tool)?.inputSchema.properties?.limit)
      .toMatchObject({ maximum: 10 });
  });

  it("dispatches once with the personal credential, basic depth and budget after live catalog validation", async () => {
    const sent: { method: string; params: unknown }[] = [];
    const budget = searchBudget();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer personal-test-token");
      expect(new Headers(init.headers).has("X-Tavily-Access-Mode")).toBe(false);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list"
        ? { tools: [tavilyRemoteSearch, { ...tavilyRemoteSearch, name: "tavily_extract" }] }
        : { content: [{ type: "text", text: "fixture results" }] } });
    });
    const client = new McpClient(tavily.endpoint, async () => "personal-test-token", "session", {}, budget);
    await client.callTool(tavily.tool, { query: "test", time_range: "week", topic: "general" });
    expect(sent.map(call => call.method)).toEqual(["tools/list", "tools/call"]);
    expect(sent[1].params).toEqual({ name: tavily.tool, arguments: {
      query: "test", time_range: "week", topic: "general", search_depth: "basic", max_results: 5,
    } });
    expect(budget.reserve).toHaveBeenCalledOnce();
    expect(budget.settle).toHaveBeenCalledOnce();
  });

  it("never reserves credits or dispatches search when the provider's const conflicts", async () => {
    const budget = searchBudget();
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      methods.push(body.method);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        tools: [withProperty("topic", { type: "string", const: "news" })],
      } });
    });
    const client = new McpClient(tavily.endpoint, async () => "personal-test-token", "session", {}, budget);
    await expect(client.callTool(tavily.tool, { query: "test" })).rejects.toBeInstanceOf(McpCallNotDispatchedError);
    expect(methods).toEqual(["tools/list"]);
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
  });
});
