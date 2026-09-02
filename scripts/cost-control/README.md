# Production cost-control alerts

This directory contains the independent scheduled evaluator for the nine alerts in
`docs/cost-control-runbook.md`. It is deliberately outside `packages/`: the current customer
release manifest only classifies the Workshop Backend, Router, and gatekeepers, so adding an
unclassified deployable package would break release generation.

The monitor reads Cloudflare metrics with a dedicated token, stores only alert edge state and
random reservation IDs in a dedicated KV namespace, and sends incident/recovery transitions through
a restricted Cloudflare Email Service binding and/or an optional HTTPS webhook. It never stores or
emits prompts, user IDs, workspace IDs, filenames, provider messages, or credentials. A source
failure produces `insufficient_data`; it cannot recover a firing alert.

## Required production configuration

- A dedicated KV namespace bound as `ALERT_STATE`.
- A least-privilege token secret named `CLOUDFLARE_API_TOKEN` with Account Analytics Read, Workers
  Observability Write, AI Gateway Read, and Workers Scripts Read for the deployment account. Workers
  Scripts Read is used only to list stored Overseer IDs before metadata RPC, preventing a deleted
  workspace from being re-instantiated during orphan reconciliation.
- Read-only bindings to the existing workspace R2 bucket (`WORKSPACE_BLOBS`) and the Backend's named
  `CostControlReconciler` entrypoint (`BACKEND_RECONCILER`).
- The non-secret account, Backend service, Overseer namespace, AI Gateway, maximum agent duration,
  and deployment label variables shown in `wrangler.cost-control.example.jsonc`.
- For email delivery, an `ALERT_EMAIL` Email Service binding restricted to the configured sender and
  recipients, plus `ALERT_EMAIL_FROM` and comma-separated `ALERT_EMAIL_TO` variables. All three must
  be configured together. Only firing and recovery edges send email; a failed delivery leaves the
  previous state uncommitted so the next scheduled run retries it.
- Optional `ALERT_WEBHOOK_URL` and secret `ALERT_WEBHOOK_TOKEN`.

Copy the example to an ignored production Wrangler file, replace its non-secret placeholders, add
the two secrets with `wrangler secret put`, and deploy with the repository-pinned Wrangler. Do not
commit namespace IDs for customer instances or secret values.

Before creating the KV namespace or deploying the Worker, export the four non-secret variables from
the example config and run the fail-closed token preflight:

    node scripts/cost-control/token-preflight.ts

The command reads the token only from `CINASEEK_AI_GATEWAY_TOKEN`, exercises all four production
capabilities, prints only `ok`, bounded HTTP-like statuses, and numeric provider codes, and exits 1
unless every check passes. It never falls back to a broader token.

The scheduled evaluator runs every 15 minutes. The immediate realtime security condition must also
be configured as a Cloudflare Workers Observability saved-query alert on
`realtime.ticket.config.invalid` or `realtime.workspace.mismatch`; the scheduled evaluator provides
stateful incident/recovery evidence and catches delivery/configuration drift.

The workspace-reopen alert reads a closed 30-minute outcome window and compares it with the latest
rolling seven-day p95 latency baseline. Because a seven-day Workers Observability scan is materially
larger than an outcome-window query, the baseline is refreshed at most once per UTC day and cached
in the same versioned KV state; a failed refresh is retried and cannot recover an incident. It fires
above a 0.5% error rate, above baseline by more than 20%, or on any
`workspace.reopen.data_lost` event. A missing or zero baseline is `insufficient_data`, never healthy.

Workspace blob integrity remains `insufficient_data` when either reconciliation binding is absent.
Passing a hard-coded zero would create a false recovery and is not supported. A complete scan is
bounded at 50,000 objects; larger deployments fail closed until the scanner is changed to persist a
resumable cursor and a stable scan generation.
