# Connector blueprint sources

This directory is the reviewable source for the official connector `.gadget` templates bundled in
`../format-blueprints/`. Run `pnpm --filter @gadgets/workshop-backend generate:connector-blueprints`
after changing the manifest or either shared source file.

Each manifest entry produces a deterministic `.gadget` archive and sidecar. The archive receives:

- the shared responsive `client.js` application shell;
- the shared `server.js` adapter, specialized with the entry's connector configuration; and
- one required Gatekeeper binding using the connector's permanent resource URL pattern.

The generated sidecars deliberately group these templates under the `integration` output id. That
makes them ordinary promoted output formats while keeping connector templates together in the New
menu and agent format catalog.

Three installed Gatekeepers intentionally have no static template here:

- `context` and `scheduler` are ambient singleton capabilities. Blueprint collection excludes
  ambient bindings by design, and they are reintroduced to agent sessions automatically.
- `mcp-portal` derives its only resource pattern from deployment-specific `MCP_PORTAL_URL`. A static
  archive cannot name that pattern portably. The generic MCP Tool Console covers user-supplied MCP
  endpoints; a portal-specific template must be published from the configured deployment.

The Email and Workers AI templates are CinaSeek production templates: their resource patterns use
`https://cinaseek.ai`. A deployment using a different public origin should keep its own blueprint
directory via `FORMAT_BLUEPRINTS_DIR`, as documented by `../format-blueprints/README.md`.

## Personal search templates

`integration.tavily-search` and `integration.firecrawl-search` use the dedicated
`search-server.js` / `search-client.js` sources and the reviewed Connections SVG assets.
They suggest the official provider's single-tool MCP resource and require a user-granted
personal account binding. The suggestion is not authorization: the MCP gatekeeper retains
all endpoint, schema, scope and personal-budget checks. No credentials are embedded.

Opening, refreshing, or exporting the template makes no search call. A form submission
executes one fixed search tool with bounded arguments; Tavily uses basic search only.
The UI suppresses double submissions and the server refuses concurrent calls in its active
instance. This is not a durable exactly-once guarantee across a crash or an explicit new
submission. There are no automatic retries, scraping, research, or platform-paid fallbacks.
Results are page-local, not persisted; credits are displayed only if the provider reports them.

Run `node --test scripts/search-blueprints.test.js` from the workspace root for logic/DOM
coverage (mocked platform base classes, not a workerd integration test). Provider schema
compatibility and authenticated live calls remain separate production acceptance checks.
