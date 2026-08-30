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
