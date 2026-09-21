import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpCallNotDispatchedError, callMayHaveTakenEffect } from "../src/client.js";
import { SEARCH_PRESETS } from "../src/search-presets.js";
import { searchBudget } from "./search-budget-fixture.js";

const [preset] = SEARCH_PRESETS;
const tool = { name: preset.tool, inputSchema: { type: "object", required: ["query"], properties: {
  query: { type: "string" }, max_results: { type: "number" },
  search_depth: { type: "string", enum: ["basic", "advanced"] },
} } };

function transport(response: () => Response | Promise<Response> = () => Response.json({
  jsonrpc: "2.0", result: { content: [] },
})) {
  const paid = vi.fn(response);
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return body.method === "tools/list"
      ? Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [tool] } }) : paid();
  });
  return paid;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("personal search budget dispatch boundary", () => {
  it("fails closed for legacy accounts with no budget", async () => {
    const paid = transport();
    const client = new McpClient(preset.endpoint, async () => "test-token", "session");
    await expect(client.callTool(preset.tool, { query: "test" })).rejects.toThrow(/Remove it and add/);
    expect(paid).not.toHaveBeenCalled();
  });

  it("does not reserve during discovery and reserves once immediately before dispatch", async () => {
    const budget = searchBudget();
    const paid = transport(() => {
      expect(budget.reserve).toHaveBeenCalledOnce();
      expect(budget.settle).not.toHaveBeenCalled();
      return Response.json({ jsonrpc: "2.0", result: { content: [] } });
    });
    const client = new McpClient(preset.endpoint, async () => "test-token", "session", {}, budget);
    await client.listTools(10);
    expect(budget.reserve).not.toHaveBeenCalled();
    await client.callTool(preset.tool, { query: "test" });
    expect(paid).toHaveBeenCalledOnce();
    const [provider, id] = budget.reserve.mock.calls[0];
    expect(provider).toBe("tavily");
    expect(id).toMatch(/^\d{13}:[0-9a-f-]{36}$/);
    expect(budget.settle).toHaveBeenCalledWith(id, "sent-or-unknown");
  });

  it("does not dispatch or guess settlement when reservation RPC fails", async () => {
    const paid = transport();
    const budget = searchBudget();
    budget.reserve.mockRejectedValue(new Error("RPC response lost"));
    const client = new McpClient(preset.endpoint, async () => "test-token", "session", {}, budget);
    await expect(client.callTool(preset.tool, { query: "test" })).rejects.toBeInstanceOf(McpCallNotDispatchedError);
    expect(paid).not.toHaveBeenCalled();
    expect(budget.settle).not.toHaveBeenCalled();
  });

  it.each(["revoked", "expired"])("refunds a proven pre-fetch failure: %s", async reason => {
    const paid = transport();
    const budget = searchBudget();
    let reserved = false;
    budget.reserve.mockImplementation(async () => {
      reserved = true;
      return { expiresAt: Date.now() + (reason === "expired" ? -1 : 60_000) };
    });
    const client = new McpClient(preset.endpoint, async () => {
      if (reserved && reason === "revoked") throw new Error("Connection disconnected");
      return "test-token";
    }, "session", {}, budget);
    await expect(client.callTool(preset.tool, { query: "test" })).rejects.toThrow();
    expect(paid).not.toHaveBeenCalled();
    expect(budget.settle).toHaveBeenCalledWith(budget.reserve.mock.calls[0][1], "not-dispatched");
  });

  it.each([401, 403, 402, 429, 500, 307])("keeps the count after HTTP %s, without following paid redirects", async status => {
    const paid = transport(() => new Response(null, { status, headers: { Location: preset.endpoint } }));
    const budget = searchBudget();
    const client = new McpClient(preset.endpoint, async () => "test-token", "session", {}, budget);
    await expect(client.callTool(preset.tool, { query: "test" })).rejects.toThrow();
    expect(paid).toHaveBeenCalledOnce();
    expect(budget.settle).toHaveBeenCalledWith(budget.reserve.mock.calls[0][1], "sent-or-unknown");
  });

  it.each(["network", "malformed", "oversized", "rpc-error"])("keeps the count after %s failure", async failure => {
    const paid = transport(() => {
      if (failure === "network") throw new Error("Network timeout");
      if (failure === "rpc-error") return Response.json({ jsonrpc: "2.0", error: { code: -1, message: "failed" } });
      return new Response(failure === "oversized" ? "x".repeat(262145) : "{", {
        headers: { "Content-Type": "application/json" },
      });
    });
    const budget = searchBudget();
    const client = new McpClient(preset.endpoint, async () => "test-token", "session", {}, budget);
    await expect(client.callTool(preset.tool, { query: "test" })).rejects.toThrow();
    expect(paid).toHaveBeenCalledOnce();
    expect(budget.settle).toHaveBeenCalledWith(budget.reserve.mock.calls[0][1], "sent-or-unknown");
  });

  it("treats failed settlement after dispatch as uncertain and never repeats the search", async () => {
    const paid = transport();
    const budget = searchBudget();
    budget.settle.mockRejectedValue(new Error("RPC unavailable"));
    const client = new McpClient(preset.endpoint, async () => "test-token", "session", {}, budget);
    const error = await client.callTool(preset.tool, { query: "test" }).catch(cause => cause);
    expect(String(error)).toContain("Do not automatically repeat");
    expect(callMayHaveTakenEffect(error)).toBe(true);
    expect(paid).toHaveBeenCalledOnce();
  });
});
