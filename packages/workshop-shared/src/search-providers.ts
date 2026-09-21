/** Personal OAuth search providers, shared by connector discovery and endpoint enforcement. */
export const PERSONAL_SEARCH_PROVIDERS = [
  { id: "tavily", name: "Tavily", endpoint: "https://mcp.tavily.com/mcp", tool: "tavily_search" },
  { id: "firecrawl", name: "Firecrawl", endpoint: "https://mcp.firecrawl.dev/v2/mcp-oauth", tool: "firecrawl_search" },
] as const;

/** One supported personal search provider; these are presets of MCP, not separate vendors. */
export type PersonalSearchProvider = typeof PERSONAL_SEARCH_PROVIDERS[number];

/**
 * Identifies official endpoints for UI branding, ignoring fragments and a single trailing slash.
 * This is not a scope or authorization check; the MCP gatekeeper validates grants independently.
 */
export function personalSearchProviderForUrl(value: string | undefined): PersonalSearchProvider | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search) return undefined;
    return PERSONAL_SEARCH_PROVIDERS.find(provider =>
      url.origin + url.pathname.replace(/\/$/, "") === provider.endpoint);
  } catch {
    return undefined;
  }
}
