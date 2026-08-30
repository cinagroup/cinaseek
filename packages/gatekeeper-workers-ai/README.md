# Cloudflare Workers AI gatekeeper

This gatekeeper stores one user-owned Cloudflare Account ID and Workers AI API Token, discovers the
account's current model catalog, and exposes model-scoped capabilities to CinaSeek.

## Capabilities

- Text-generation models appear in **Providers → Add model → Cloudflare Workers AI**.
- Embeddings, text-to-image, speech recognition, text-to-speech, and text classification models can
  be selected as a Gatekeeper resource and bound to a workspace.
- Model discovery uses Cloudflare's account-scoped model-search API. The catalog is cached for five
  minutes and model input schemas for 24 hours.
- Existing curated text-generation models can still contribute credentials to CinaSeek's shared,
  per-model routing pool. Non-chat resource bindings remain private to the account owner.

## Credentials and authorization

Create a Cloudflare API Token accepted by the Workers AI API (`Workers AI Read` or `Workers AI
Write`) and copy the 32-character Account ID. The connection form validates both by listing models
before it stores them.

Credentials live only in the gatekeeper account Durable Object. The authenticated browser can read
connection status and model metadata, but never the Account ID or token. Each non-chat inference is
recorded as an observation before caller content is sent to Cloudflare.

## Development

From the repository root:

```sh
pnpm exec vp run -F @gadgets/workers-ai-gatekeeper build
pnpm --filter @gadgets/workers-ai-gatekeeper test:run
pnpm dev-server
```

`pnpm dev-server` discovers this package automatically and generates its local service bindings.
