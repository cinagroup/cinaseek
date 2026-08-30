# User-funded Workers AI and the shared credential pool

CinaSeek does not use the deployment owner's Cloudflare account to fund Workers AI inference.
A Workers AI model becomes available only when an authenticated user adds a Cloudflare Account ID
and Workers AI API Token, or when another user has explicitly contributed credentials for that
curated model to the shared pool.

## User experience

- Adding a Workers AI model always requires the user's own 32-character Cloudflare Account ID and
  API Token, including deployments that also have a platform AI Gateway.
- A model is private by default and calls the account entered by its owner directly.
- For a curated Workers AI model, the owner can opt in to **Share with other CinaSeek users** while
  adding it, or change the setting later from Providers.
- A pooled model is visible to authenticated users only while at least one credential is present.
  Pool recipients see aggregate pool size and availability, never contributor identity, Account ID,
  or Token.
- Unsharing or deleting a shared model immediately removes that user's credential from future pool
  selection. Existing in-flight requests are not interrupted.

The credential owner pays Cloudflare for requests assigned to their credential. Sharing therefore
must remain an explicit opt-in; CinaSeek does not imply reimbursement or per-contributor spend caps.

## Routing

`WorkersAiCredentialPool` is a SQLite Durable Object sharded by curated model ID. Each user has at
most one credential in a model's pool. Before each request, the object selects the least recently
used credential whose cooldown has expired, then updates its last-used timestamp before making the
upstream call. This gives deterministic load distribution without a global cross-model bottleneck.

Failed credentials are temporarily excluded from subsequent requests:

| Upstream result | Cooldown |
| --- | ---: |
| `401` / `403` | 15 minutes |
| `429` | 60 seconds |
| `5xx` | 15 seconds |
| Network failure | 30 seconds |

The current response is returned unchanged and streamed to the caller. CinaSeek does not replay the
same prompt with another credential because safely retrying a streaming request would require
buffering potentially large or sensitive request bodies. The next request automatically routes
around the cooled credential.

## Security boundary

- Account IDs and Tokens are validated server-side before storage. Client-side checks are only for
  faster feedback.
- Private credentials stay in the owner's `UserDurableObject`. Shared credentials are additionally
  stored in the model pool Durable Object and are encrypted at rest by Cloudflare's platform.
- Tokens never enter frontend model-list responses, aggregate pool status, logs, error events, or
  AI Gateway metadata.
- The pool can call only Cloudflare's fixed
  `/client/v4/accounts/{account}/ai/v1/chat/completions` endpoint. Users cannot supply an arbitrary
  URL, and only an allowlist of content/accept/session-affinity headers is forwarded.
- Only models in `SUGGESTED_MODELS.cloudflare` can be shared. Custom Workers AI model IDs remain
  private.
- The deployment `WORKERS_AI` binding may still support non-inference features such as document to
  Markdown conversion, but it is never selected for chat/model inference.

## Operations

The `v3` backend Durable Object migration creates `WorkersAiCredentialPool`. No external binding is
needed because instances are reached through `ctx.exports.WorkersAiCredentialPool`.

If a contributor revokes a Token in Cloudflare without first unsharing it, requests receiving
`401`/`403` place that credential in cooldown. The contributor should update or delete the model in
CinaSeek, then add the replacement credential. Pool health shown in Providers reflects total and
currently available credentials.
