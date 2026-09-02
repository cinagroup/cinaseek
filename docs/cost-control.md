# Cost control and runtime lifecycle

This document defines the measurement contract and architectural invariants for making the
Workshop economical at commercial scale. It intentionally separates authoritative Cloudflare
billing data from product events: Cloudflare metrics determine what was billed, while Workshop
events explain which user-visible activity caused it.

## Architectural invariants

1. `OverseerDurableObject` remains the only authoritative owner of workspace state, ordering, and
   authorization decisions.
2. The hibernatable realtime Durable Object carries presence and best-effort console events, but
   it must not become a second source of workspace truth or mint authority of its own.
3. Long-running agent orchestration may move to Workflows, but Workflow state must contain only
   serializable identifiers and non-secret configuration. RPC stubs, OAuth tokens, and provider
   keys must be reacquired through their existing capability boundaries.
4. Durable Object storage remains the hot transactional tier. R2 is for immutable or cold blobs;
   moving data must not weaken workspace authorization or deletion guarantees.
5. Product limits must reject or reserve expensive work before the external charge is incurred.

## Cost units

The operating dashboard and capacity model use these normalized units:

| Unit | Definition |
| --- | --- |
| Active object hour | Sum of billable active seconds across all Durable Objects, divided by 3600. |
| Visible workspace minute | A minute in which a workspace tab is foreground-visible. |
| Interactive workspace minute | A visible minute containing user input, an RPC, or a rendered gadget interaction. |
| Agent run | One invocation of the durable agent loop, including a resumed or callback-initiated run. |
| Dynamic Worker day | One distinct Worker Loader identity requested on one UTC day. |
| Workspace hot bytes | Workspace data retained in Durable Object SQLite. |
| Workspace blob bytes | Workspace-owned immutable/cold data retained in R2. |
| Platform-funded AI USD | Model cost charged to deployment-managed credentials. |
| BYOK AI USD | Model cost routed to credentials owned by the user or connected account. |

The cost model is:

```text
COGS = Durable Object duration, requests, and storage
     + Worker and Dynamic Worker requests and CPU
     + Workflow requests, CPU, steps, and storage
     + R2 storage and operations
     + platform-funded model usage
     + Browser and external-service usage
```

Rates must not be copied into application code. Capacity reports should apply the billing-period
rates from the current Cloudflare invoice or official pricing documentation.

## Authoritative platform data

Durable Object usage is read from Cloudflare's GraphQL analytics datasets:

- `durableObjectsInvocationsAdaptiveGroups`
- `durableObjectsPeriodicGroups`
- `durableObjectsStorageGroups`
- `durableObjectsSubrequestsAdaptiveGroups`

Dynamic Worker billing is reconciled against `distinctDynamicWorkerCount`. Product events are not
allowed to claim exact billable duration or exact distinct-worker counts, because a Worker or
Durable Object can terminate without running application cleanup code.

References:

- <https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/>
- <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- <https://developers.cloudflare.com/dynamic-workers/pricing/>

## Operational event contract

Operational events use the existing optional `PRODUCT_ANALYTICS` Pipeline. They contain IDs and
bounded dimensions, never prompts, tool arguments, attachment names, access tokens, or secrets.
The historical `gadget_id` column identifies the workspace; `workpiece_id` identifies a gadget
inside that workspace.

### Workspace RPC sessions

- `workspace_session_started` records the accepted workspace RPC session, its source, and a random
  `session_id`.
- `workspace_session_finished` records the same `session_id`, elapsed milliseconds, and whether it
  closed normally or because the Durable Object connection was lost.
- A start without a finish is expected when the containing Worker is terminated. Dashboards must
  use Cloudflare duration as the billing truth and treat incomplete pairs as a reliability signal.
- The browser sends a lightweight `PublicApi.ping()` every 25 seconds. This keeps Cloudflare's idle
  WebSocket timeout from turning an otherwise idle tab into an expensive reconnect/replay loop.
  Workspace stubs are disposed independently by the 90-second hidden and five-minute visible-idle
  leases, so the transport heartbeat does not keep a suspended Workspace Durable Object active.
- `workspace_reopen_finished` records the client-observed outcome and latency after one of those
  leases resumes. It also carries bounded `draft_state` and `attachment_state` integrity outcomes,
  never composer contents or attachment metadata. The authenticated connection accepts reports only
  for a workspace it has successfully opened so another account cannot manufacture metrics for an
  unopened workspace.
- The scheduled cost-control Worker evaluates reopen errors over a closed 30-minute window, compares
  successful-reopen p95 latency with the preceding rolling seven-day baseline, and pages immediately
  if a draft or attachment is reported lost. The strict abort thresholds are error rate above 0.5%,
  p95 above baseline by more than 20%, or any loss report.

### Agent runs

- `agent_run_started` identifies the workspace, chat, model, initiating account, and whether the
  run came from a callback.
- `agent_run_finished` adds elapsed milliseconds and one of `ok`, `error`, `cancelled`,
  `usage_limit`, or `callbacks_stalled`.
- A durable `execution_id` will be added with the Workflow/idempotency migration. Until then,
  analytics can correlate runs only by workspace, chat, and event time.

### Dynamic Workers

- `dynamic_worker_requested` records the exact stable ID passed to `LOADER.get()`, the workpiece,
  execution version, and whether it is a mainline or preview load.
- Repeated requests for the same `worker_id` are deliberately preserved. Reports can estimate
  unique identities with a UTC-day distinct count, then reconcile that estimate with Cloudflare.

## Required dashboards and gates

Before changing lifecycle behavior, collect at least fourteen representative days and publish:

1. Durable Object GB-s by namespace and day.
2. Workspace session duration compared with visible and interactive client time.
3. Agent duration and outcome, split by callback and model.
4. Dynamic Worker requests and daily distinct identities, split by preview/mainline.
5. Durable Object stored bytes and R2 bytes.
6. Platform-funded and BYOK model cost.
7. Cost per active user, workspace hour, and successful agent run.

The first implementation gate is met when daily cost attribution is within 15% of the invoice and
the dashboard can quantify hidden-tab duration, agent-wait duration, and preview-version churn.

## Privacy and cardinality rules

- Never emit chat text, prompts, tool inputs, filenames, URLs containing credentials, or provider
  responses.
- `session_id` is random and short-lived; it is not an authentication credential.
- Do not turn workspace, user, session, execution, or worker IDs into metric labels. They belong in
  structured event fields queried only when attribution is necessary.
- High-frequency streaming chunks and heartbeat messages are not individual analytics events.
- Sampling changes must preserve errors, limit rejections, and lifecycle finish events.

## Rollout sequence

1. Collect and reconcile these events without changing runtime behavior.
2. Suspend hidden idle workspace sessions behind a runtime flag.
3. Introduce a hibernatable realtime channel and migrate long-lived subscriptions.
4. Change Overseer access to short leases.
5. Move agent orchestration to Workflows with durable idempotency.
6. Move eligible blobs to R2, reduce Dynamic Worker version churn, and enforce commercial limits.

Every behavioral stage must be independently reversible without downgrading stored data.

## Implemented lifecycle switches

The first lifecycle changes are dark by default and are controlled through the existing UI
feature-flag mechanism:

Production self-hosted instances can attach their account-local Cloudflare Flagship app without
putting its app ID in the reusable release manifest:

    node scripts/deploy-cloudflare.mjs --domain example.com \
      --flagship-app-id <app-uuid> [other production options]

The generated, gitignored production config binds that app as `FLAGS`, and later deployments
preserve the binding when the option is omitted. The source `wrangler.jsonc` and customer release
manifest intentionally do not carry an app ID because Flagship apps are account-specific. An
instance without the binding fails closed to the defaults below.

| Flag | Default | Behaviour | Immediate rollback |
| --- | --- | --- | --- |
| `workspace-idle-suspension` | off | Dispose the Overseer subscription after a tab is hidden for 90 seconds or a visible tab is idle for five minutes, only when no agent run, attachment/send operation, or unacknowledged local edit is active. Reopen automatically on visibility or user activity. | Disable the flag; clients retain their existing Overseer connection. |
| `realtime-presence` | off | Carry presence snapshots and, when the separate server gate is enabled, best-effort console events over a hibernatable per-workspace WebSocket Durable Object. During rollout, legacy and realtime rosters are merged so old and new clients remain visible to each other. | Disable the flag; clients use the legacy RPC subscriptions again. Stored realtime roster data is non-authoritative and may be left in place. |

`realtime-presence` additionally requires `REALTIME_TICKET_SECRET` on the Workshop backend. The
secret must contain at least 32 bytes of deployment-unique entropy. Tickets are HMAC-signed,
expire after one minute, are scoped to one authorized workspace participant, are sent as a
WebSocket subprotocol rather than in the URL, and are one-use at the realtime Durable Object.
Do not enable the flag until the secret is installed on every backend version receiving traffic.
Console delivery additionally requires `REALTIME_CONSOLE_ENABLED=true`. Its ticket is issued only
to build-role sessions, and the router and realtime object both fail closed if the server gate is
off. This separate gate lets operators canary console fan-out after presence is stable. Console
events remain best-effort and are neither stored nor replayed.
Both bridges activate lazily per workspace after a client requests the corresponding channel, so
dark deployments and workspaces outside the UI flag cohort do not pay mirror/fan-out DO requests.

The migration boundary is intentionally explicit:

| Long-lived feed | Current transport | Migration status |
| --- | --- | --- |
| Presence | Hibernatable realtime WebSocket, with legacy bridge | Migrated behind flag |
| Workspace metadata | Overseer RPC subscription | Pending snapshot/invalidation migration |
| Workpiece list | Overseer RPC subscription | Pending snapshot/invalidation migration |
| Action changes | Overseer RPC subscription with resumable cursor | Pending resumable-event migration |
| Chat/OT changes | Overseer RPC subscription with strict ordering | Remains on Overseer until the realtime channel has durable cursors and replay tests |
| Console tail | Hibernatable realtime WebSocket, non-durable, with RPC fallback | Migrated behind paired UI/server switches |

Presence rollout should progress from internal accounts, to a small canary deployment, to 10%,
50%, and 100% of sessions. After presence is stable, enable `REALTIME_CONSOLE_ENABLED` on a canary
backend cohort before widening it. At each stage compare realtime connection failures, ticket
rejections, legacy/realtime roster divergence, missing/duplicate console events, Overseer active
duration, and realtime Durable Object duration. Rollback is a flag or environment-variable change;
no state-schema downgrade is required.

## Bounded agent execution and Workflow decision

Agent model waits still execute inside the authoritative Overseer in this release. A Workflow that
awaits the same long Overseer RPC would leave the object active and add Workflow billing, so it is
not shipped as a cosmetic wrapper. The resumable, idempotent state-machine boundary and release
gates are specified in `docs/agent-workflow-migration.md`.

Two server-side ceilings bound the legacy runner now:

| Variable | Default | Accepted range | Effect |
| --- | ---: | ---: | --- |
| `AGENT_MAX_TURNS` | 30 | 1–30 | Stops the model/tool loop after this many completed model turns. |
| `AGENT_MAX_DURATION_MS` | 1,800,000 | 60,000–3,600,000 | Signals cancellation for the entire agent run, including compaction and callback nudges, after this wall time. |

Invalid values fail to the bounded defaults. Commercial deployments should lower the turn ceiling
only after measuring completion rates: a lower value reduces worst-case provider and DO cost but
can end multi-tool tasks before the agent produces a final explanation. Duration-limit outcomes
are emitted as `agent_run_finished.outcome=timeout` and should be graphed separately from provider
errors.

Model requests observe the cancellation signal. A tool implementation that has already crossed an
external non-cancellable boundary may still finish before the agent's atomic persistence barrier
and cleanup run; the duration ceiling is therefore a spend guard, not a hard process kill.

## Workspace blob tiering

Chat attachment metadata and authorization remain in the workspace Durable Object. Immutable
attachment bodies can be stored under
`workspaces/<workspace-id>/chat-attachments/<attachment-id>` in the `WORKSPACE_BLOBS` R2 bucket.
The optional `WORKSPACE_BLOB_MODE` variable controls migration:

| Mode | New writes | Reads | Intended use |
| --- | --- | --- | --- |
| unset / `disabled` | Durable Object only | Durable Object | Dark deployment and application rollback |
| `mirror` | R2 and Durable Object | Durable Object first, R2 fallback | Canary and rollback window |
| `r2` | R2 body plus Durable Object metadata | R2 first; legacy DO-only bodies are promoted lazily | Cost-saving steady state |

Do not switch a deployment to `r2` until mirror writes and R2 reads have been observed without
errors for at least one retention window. Deleting a staged attachment, a chat, or a workspace
also deletes its R2 objects; workspace deletion lists the workspace prefix in bounded pages.
R2 deletion failures must fail the destructive operation so bytes are not silently orphaned. The
production release contract always provisions the bucket; use unset/`disabled` for dark deployment
and application rollback instead of removing the binding from a running release.
Before any R2 write, the workspace DO reserves the attachment's bytes against
`WORKSPACE_ATTACHMENT_LIMIT_BYTES` (1 GiB by default), so concurrent uploads cannot bypass the
ceiling or incur unbounded object-storage spend. It also enforces
`WORKSPACE_ATTACHMENT_LIMIT_COUNT` (2,000 by default, configurable up to 100,000), so empty or tiny
objects cannot create an unbounded number of DO rows and R2 operations. A persistent aggregate
ledger makes these checks O(1); an older workspace computes that ledger once on its first upload
after upgrade, and every staged/committed deletion updates it transactionally thereafter.

## Commercial quota reservation

Platform-funded, non-Workers-AI agent runs use the existing per-user daily limit and Cloudflare
BYOK decision path. The check now reserves the allowance atomically on the User Durable Object
before the Overseer starts inference. A reservation is:

- settled as consumed once the model invocation starts, including provider failures that may have
  incurred cost;
- released when setup fails or the run is cancelled before inference starts;
- fail-closed if settlement is interrupted, so a crash can under-use the free tier but cannot
  overspend it; and
- reported separately in the usage settings UI while still being included in used/remaining
  calculations.

Funded BYOK requests bypass the platform reservation entirely and continue to refresh the user's
cached AI Gateway balance after the run. Callback continuations retain their existing exemption so
an already-started external workflow is not stranded mid-flight.
