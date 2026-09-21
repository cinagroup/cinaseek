import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BindingBadge, uniqueBindingBadges } from "./BlueprintCard";
import type { BlueprintBinding } from "@gadgets/workshop-shared/api";

const binding = (resourceUrl: string): BlueprintBinding => ({
  type: "gatekeeper", gatekeeperName: "mcp", typeUrlPattern: "https://*",
  title: "Search", description: "Personal search", resourceUrl,
});

describe("search blueprint branding", () => {
  it("keeps two provider badges distinct while deduplicating each provider", () => {
    const badges = uniqueBindingBadges({
      a: binding("https://mcp.tavily.com/mcp#tool=tavily_search"),
      b: binding("https://mcp.firecrawl.dev/v2/mcp-oauth#tool=firecrawl_search"),
      c: binding("https://mcp.tavily.com/mcp"),
    });
    expect(badges.map(b => b.searchBrand?.name)).toEqual(["Tavily", "Firecrawl"]);
    for (const badge of badges) {
      const html = renderToStaticMarkup(createElement(BindingBadge, { badge, vendorDescriptions: new Map([["mcp", { displayName: "MCP Server", url: "https://modelcontextprotocol.io" }]]) }));
      expect(html).toContain(badge.searchBrand!.name);
      expect(html).toContain("data:image/svg+xml");
      expect(html).not.toContain("MCP Server");
    }
  });
  it("does not brand lookalike endpoints as a personal provider", () => {
    const [badge] = uniqueBindingBadges({ a: binding("https://mcp.tavily.com.evil.example/mcp") });
    expect(badge.searchBrand).toBeUndefined();
    expect(badge.vendorKey).toBe("mcp");
  });
});
