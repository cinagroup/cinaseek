// The one page this gatekeeper serves that asks the user something: which MCP server to connect.
// Lives here rather than in `@gadgets/mcp-shared/html` because the gateway connector, whose endpoint
// is a deployment setting, has no equivalent page.

import { escapeHtml, PAGE_STYLE } from "@gadgets/mcp-shared/html";
import { SEARCH_PRESETS } from "@gadgets/mcp-shared/search-presets";

/** Resolves a preset on the server; posted URLs cannot replace a preset's OAuth endpoint. */
export function connectEndpoint(form: FormData): string {
  if (form.has("preset")) {
    const preset = SEARCH_PRESETS.find(item => item.id === form.get("preset"));
    if (!preset || form.getAll("preset").length !== 1 || form.has("url")) {
      throw new Error("Choose a supported personal search connection.");
    }
    return preset.endpoint;
  }
  const endpoint = form.get("url");
  if (typeof endpoint !== "string" || form.getAll("url").length !== 1) {
    throw new Error("Enter one MCP server endpoint.");
  }
  return endpoint;
}

// Form controls, on top of the palette and page frame every connect page shares.
const FORM_STYLE = `
  label { display: block; font-size: 14px; font-weight: 600; color: var(--strong); margin: 0 0 6px; }
  p.hint { margin: 6px 0 0; font-size: 13px; color: var(--subtle); }

  input[type=url] { width: 100%; box-sizing: border-box; padding: 9px 11px; font: inherit;
                    background: var(--control); color: var(--text);
                    border: 1px solid var(--line); border-radius: 8px; }
  input[type=url]::placeholder { color: var(--subtle); }
  input[type=url]:focus { outline: 0; border-color: var(--brand);
                          box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }

  button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px;
           background: var(--contrast); color: var(--on-contrast); font: inherit; font-weight: 600;
           cursor: pointer; }
  button:hover { opacity: .9; }
`;

/** Renders the endpoint prompt shown when the user starts connecting. */
export function connectFormHtml(path: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an MCP server</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main>
  <h1>Connect an MCP server</h1>
  <p class="sub">We will discover the server's tools and, if it requires authorization, take you
  through its sign-in.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <section aria-label="Personal search accounts">
    <h2>Search with your own account</h2>
    <p class="hint">Sign in on the provider's website. Searches use the credits of the personal
    or team account you authorize, never a fallback CinaSeek key. Confirm the billing account in
    the provider's dashboard. Provider OAuth may authorize broader capabilities, but CinaSeek exposes
    only search; page scraping and research are not enabled.</p>
    ${SEARCH_PRESETS.map(preset => `<form method="POST" action="${escapeHtml(path)}">
      <input type="hidden" name="preset" value="${preset.id}">
      <button type="submit">Connect ${preset.name} account</button>
    </form>`).join("\n")}
  </section>
  <h2>Custom MCP server</h2>
  <form method="POST" action="${escapeHtml(path)}">
    <label for="url">Server URL</label>
    <input id="url" type="url" name="url" placeholder="https://example.com/mcp" required autofocus>
    <p class="hint">Only connect a server you trust. Its own annotations decide which of its tools
    run without asking you and which wait for your approval, and an annotation is only as
    trustworthy as the server that sent it.</p>
    <button type="submit">Continue</button>
  </form>
</main></body></html>`;
}
