import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const CONFIG = __CONNECTOR_CONFIG__;

/** Gadget sandbox entrypoint; the sandbox supplies the user-granted personal search binding. */
export class Gadget extends DurableObject {
  #searching = false;

  async getConfig() {
    return {
      title: CONFIG.title, logoUrl: CONFIG.logoUrl,
      provider: CONFIG.connector, binding: CONFIG.binding.name,
      minResults: CONFIG.connector === "tavily" ? 5 : 1,
    };
  }

  async search(query, limit) {
    const min = CONFIG.connector === "tavily" ? 5 : 1;
    if (typeof query !== "string" || !query.trim() || query.length > 2000) {
      throw new Error("Enter a query of 1–2000 characters.");
    }
    if (!Number.isInteger(limit) || limit < min || limit > 10) {
      throw new Error(`Result limit must be ${min}–10.`);
    }
    const session = this.env[CONFIG.binding.name];
    if (!session) throw new Error(`Connect your personal account using ${CONFIG.binding.name} first.`);
    if (this.#searching) throw new Error("A search is already running. Wait for its result.");
    this.#searching = true;
    try {
      // Fixed names/arguments only. The gatekeeper enforces endpoint, grant, schema and budget.
      // Never retry: an uncertain response may already have consumed personal credits.
      const result = CONFIG.connector === "tavily"
        ? await session.callTool("tavily_search", { query: query.trim(), max_results: limit, search_depth: "basic" })
        : await session.callTool("firecrawl_search", { query: query.trim(), limit });
      if (result?.status !== "ok" || result.isError) {
        throw new Error("Search did not complete. Check the connection or pending approval. No automatic retry was made.");
      }
      const payload = readPayload(result);
      if (payload.success === false) throw new Error("The provider reported a failed search. No automatic retry was made.");
      const rows = CONFIG.connector === "tavily" ? payload.results : payload.data?.web ?? payload.data;
      if (!Array.isArray(rows)) throw new Error("Unrecognized search response. Credits may have been consumed; no retry was made.");
      return {
        rows: rows.slice(0, limit).map(row => ({
          title: text(row?.title, 300), url: safeUrl(row?.url),
          description: text(row?.description ?? row?.content, 3000),
        })),
        creditsUsed: typeof payload.creditsUsed === "number" && Number.isFinite(payload.creditsUsed) && payload.creditsUsed >= 0
          ? payload.creditsUsed : null,
      };
    } finally {
      this.#searching = false;
    }
  }
}

function readPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const raw = result.text || result.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (typeof raw !== "string" || raw.length > 1_000_000) throw new Error("Search response is missing or too large. No retry was made.");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Unrecognized search response. No retry was made."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid search response.");
  return parsed;
}

function text(value, max) { return typeof value === "string" ? value.slice(0, max) : ""; }
function safeUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

/** No export formats: a fresh export sandbox cannot read these page-local search results. */
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return [];
  }
}
