import type { McpTool, McpWireTool } from "./client.js";
import type { ToolScope } from "./scope.js";
import { PERSONAL_SEARCH_PROVIDERS } from "@gadgets/workshop-shared/search-providers";

/** Official personal-account search connections. No deployment credential fallback. */
export const SEARCH_PRESETS = PERSONAL_SEARCH_PROVIDERS;

/** One supported personal OAuth search provider. */
export type SearchPreset = typeof SEARCH_PRESETS[number];

/** Resolves known hosts strictly, including custom-input and previously stored connections. */
export function searchPresetForEndpoint(endpoint: string): SearchPreset | undefined {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/\.$/, "");
  const preset = SEARCH_PRESETS.find(item => new URL(item.endpoint).hostname === host);
  if (!preset) return undefined;
  const expected = new URL(preset.endpoint);
  if (url.origin !== expected.origin || url.username || url.password || url.search || url.hash
      || url.pathname.replace(/\/$/, "") !== expected.pathname) {
    throw new Error(`Use the ${preset.name} personal OAuth endpoint without credentials or parameters.`);
  }
  return preset;
}

/** Pins grants on known search endpoints; a bare URL never grants future tools. */
export function restrictSearchScope(endpoint: string, requested: ToolScope): ToolScope {
  const preset = searchPresetForEndpoint(endpoint);
  if (!preset) return requested;
  if (requested.serverId !== undefined) throw new Error("Search presets do not support portal scopes.");
  if (requested.tools?.some(name => name !== preset.tool)) {
    throw new Error("This personal search connection grants only its search tool.");
  }
  return { tools: requested.tools ?? [preset.tool] };
}

type SearchField = {
  type: "string" | "integer" | "array";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: number | string;
  enum?: string[];
  maxItems?: number;
  items?: { type: "string"; minLength: number; maxLength: number };
};

const querySchema: SearchField = { type: "string", minLength: 1, maxLength: 2000 };
const limitSchema: SearchField = { type: "integer", minimum: 1, maximum: 10, default: 5 };
const domainSchema: SearchField = {
  type: "array", maxItems: 10,
  items: { type: "string", minLength: 1, maxLength: 253 },
};

function fields(preset: SearchPreset): Record<string, SearchField> {
  return preset.id === "tavily" ? {
    query: querySchema,
    max_results: limitSchema,
    search_depth: { type: "string", enum: ["basic"], default: "basic" },
    include_domains: domainSchema,
    exclude_domains: domainSchema,
    time_range: { type: "string", enum: ["day", "week", "month", "year"] },
    // The official MCP schema supports general only, unlike the broader REST API.
    topic: { type: "string", enum: ["general"] },
  } : {
    query: querySchema,
    limit: limitSchema,
    includeDomains: domainSchema,
    excludeDomains: domainSchema,
    location: { type: "string", minLength: 1, maxLength: 200 },
    tbs: { type: "string", enum: ["qdr:h", "qdr:d", "qdr:w", "qdr:m", "qdr:y"] },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The remote Tavily server uses a nullable anyOf for time_range (unlike its public
// stdio server). Accept only one typed branch plus an unconstrained null branch;
// callers still cannot send null. Do not guess at references or general unions.
function nonNullableSearchProperty(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  if (value.anyOf !== undefined) {
    if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2
        || Object.keys(value).some(key => ![
          "anyOf", "title", "description", "default", "examples", "$comment", "deprecated",
        ].includes(key))) return undefined;
    const nullIndex = value.anyOf.findIndex(branch =>
      isObject(branch) && branch.type === "null" && Object.keys(branch).length === 1);
    if (nullIndex === -1) return undefined;
    value = value.anyOf[1 - nullIndex];
    if (!isObject(value)) return undefined;
  }
  if (typeof value.type !== "string" || value.type === "null"
      || ["$ref", "anyOf", "oneOf", "allOf", "not", "if", "then", "else"]
        .some(key => Object.hasOwn(value, key))) return undefined;
  return value;
}

function supportsSearchField(upstream: Record<string, unknown>, field: SearchField): boolean {
  const types = field.type === "integer" ? ["integer", "number"] : [field.type];
  const upstreamEnum = upstream.enum;
  if (!types.includes(String(upstream.type))) return false;
  // const is an enum of one, not an annotation. Never discard a conflicting const
  // (or malformed enum) and advertise values the provider does not accept.
  if (Object.hasOwn(upstream, "const")
      && (!field.enum || field.enum.some(value => value !== upstream.const))) return false;
  if (Object.hasOwn(upstream, "enum")
      && (!field.enum || !Array.isArray(upstreamEnum)
        || field.enum.some(value => !upstreamEnum.includes(value)))) return false;
  return true;
}

/** Narrows discoverable schemas, refusing incompatible upstream contracts instead of guessing. */
export function searchToolForEndpoint(
  endpoint: string, tool: McpWireTool,
): McpWireTool | undefined {
  const preset = searchPresetForEndpoint(endpoint);
  if (!preset) return tool;
  if (tool.name !== preset.tool) return undefined;
  const schema = tool.inputSchema;
  const properties = schema?.properties;
  const limit = preset.id === "tavily" ? "max_results" : "limit";
  const queryProperty = nonNullableSearchProperty(properties?.query);
  const limitProperty = nonNullableSearchProperty(properties?.[limit]);
  const depthProperty = nonNullableSearchProperty(properties?.search_depth);
  if (schema?.type !== "object" || !properties
      || !isObject(queryProperty) || queryProperty.type !== "string"
      || !isObject(limitProperty) || !["number", "integer"].includes(String(limitProperty.type))
      || (preset.id === "tavily" &&
        (!depthProperty || !(Array.isArray(depthProperty.enum)
          ? depthProperty.enum.includes("basic") : depthProperty.const === "basic")))) {
    throw new Error(`${preset.name} search schema changed; reconnect after compatibility is reviewed.`);
  }
  const allowed = fields(preset);
  for (const [key, field] of Object.entries(allowed)) {
    if (!Object.hasOwn(properties, key)) continue;
    const upstream = nonNullableSearchProperty(properties[key]);
    if (!upstream || !supportsSearchField(upstream, field)) {
      // key is from our static allowlist; never echo upstream schema/credentials.
      throw new Error(`${preset.name} search schema changed for ${key}; reconnect after compatibility is reviewed.`);
    }
  }
  if (schema.required?.some(key => !Object.hasOwn(allowed, key))) {
    throw new Error(`${preset.name} requires an unsupported search parameter.`);
  }
  return {
    ...tool,
    description: "Search using your connected account. At most 10 results; no page scraping or " +
      "research. Only the parameters listed here are supported.",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Object.entries(allowed).filter(([key]) => Object.hasOwn(properties, key))),
      required: [...new Set(["query", ...(schema.required ?? [])])],
      additionalProperties: false,
    },
  };
}

/** Validates the bounded search subset before a call can spend a user's credits. */
export function prepareSearchArguments(
  endpoint: string, name: string, args: Record<string, unknown>,
): Record<string, unknown> {
  const preset = searchPresetForEndpoint(endpoint);
  if (!preset) return args;
  if (name !== preset.tool) throw new Error("This connection permits search only, not scraping or research.");
  const allowed = fields(preset);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(allowed, key)) throw new Error("Unsupported personal search parameter.");
    const schema = allowed[key];
    if (schema.type === "string") {
      if (typeof value !== "string" || !value.trim()
          || value.length > Number(schema.maxLength ?? 2000)
          || (schema.enum && !schema.enum.includes(value))) {
        throw new Error(`Invalid search parameter: ${key}.`);
      }
    } else if (schema.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
        throw new Error("Search result limit must be an integer from 1 to 10.");
      }
    } else if (!Array.isArray(value) || value.length > 10 || value.some(domain =>
      typeof domain !== "string" || domain.length > 253
        || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))) {
      throw new Error("Search domains must be at most 10 public domain names.");
    }
  }
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("A search query is required.");
  if (preset.id === "firecrawl" && args.includeDomains !== undefined && args.excludeDomains !== undefined) {
    throw new Error("Choose either included or excluded domains, not both.");
  }
  return preset.id === "tavily"
    ? { ...args, search_depth: "basic", max_results: args.max_results ?? 5 }
    : { ...args, limit: args.limit ?? 5 };
}

/** Checks that an execution's parameters are still advertised by the restricted live catalog. */
export function requireSearchToolParameters(tool: McpTool | undefined, args: Record<string, unknown>): void {
  const properties = tool?.inputSchema?.properties;
  if (!properties || Object.keys(args).some(key => !Object.hasOwn(properties, key))
      || tool?.inputSchema?.required?.some(key => !Object.hasOwn(args, key))) {
    throw new Error("The search tool no longer supports this request. Reconnect and review its parameters.");
  }
}
