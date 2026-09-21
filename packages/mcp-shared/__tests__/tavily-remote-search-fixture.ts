import type { McpWireTool } from "../src/client.js";

/**
 * Remote tools/list contract observed 2026-09-21 at https://mcp.tavily.com/mcp/,
 * using the documented public metadata access mode (initialize + tools/list only).
 * https://docs.tavily.com/documentation/keyless#mcp-server
 * Descriptions omitted; schema keywords/defaults retained. This is not evidence
 * of an authenticated search: no credentials or tools/call were used to obtain it.
 */
export const tavilyRemoteSearch: McpWireTool = {
  name: "tavily_search",
  inputSchema: {
    properties: {
      query: { type: "string" },
      max_results: { default: 5, type: "integer" },
      search_depth: {
        default: "basic", enum: ["basic", "advanced", "fast", "ultra-fast"], type: "string",
      },
      topic: { const: "general", default: "general", type: "string" },
      time_range: {
        anyOf: [{ enum: ["day", "week", "month", "year"], type: "string" }, { type: "null" }],
        default: null,
      },
      include_images: { default: false, type: "boolean" },
      include_image_descriptions: { default: false, type: "boolean" },
      include_raw_content: { default: false, type: "boolean" },
      include_domains: { default: [], items: { type: "string" }, type: "array" },
      exclude_domains: { default: [], items: { type: "string" }, type: "array" },
      country: { default: "", type: "string" },
      include_favicon: { default: false, type: "boolean" },
      start_date: { default: "", type: "string" },
      end_date: { default: "", type: "string" },
      exact_match: { anyOf: [{ type: "boolean" }, { type: "null" }], default: null },
    },
    required: ["query"], type: "object", additionalProperties: false,
  },
};
