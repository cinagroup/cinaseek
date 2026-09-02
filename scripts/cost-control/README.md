# Production cost-control alerts

This directory contains the independent scheduled evaluator for the eight alerts in
`docs/cost-control-runbook.md`. It is deliberately outside `packages/`: the current customer
release manifest only classifies the Workshop Backend, Router, and gatekeepers, so adding an
unclassified deployable package would break release generation.

The monitor reads Cloudflare metrics with a dedicated token, stores only alert edge state and
random reservation IDs in a dedicated KV namespace, and optionally sends incident/recovery JSON to
an HTTPS webhook. It never stores or emits prompts, user IDs, workspace IDs, filenames, provider
messages, or credentials. A source failure produces `insufficient_data`; it cannot recover a firing
alert.

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
- Optional `ALERT_WEBHOOK_URL` and secret `ALERT_WEBHOOK_TOKEN`.

Copy the example to an ignored production Wrangler file, replace its non-secret placeholders, add
the two secrets with `wrangler secret put`, and deploy with the repository-pinned Wrangler. Do not
commit namespace IDs for customer instances or secret values.

The scheduled evaluator runs every 15 minutes. The immediate realtime security condition must also
be configured as a Cloudflare Workers Observability saved-query alert on
`realtime.ticket.config.invalid` or `realtime.workspace.mismatch`; the scheduled evaluator provides
stateful incident/recovery evidence and catches delivery/configuration drift.

Workspace blob integrity remains `insufficient_data` when either reconciliation binding is absent.
Passing a hard-coded zero would create a false recovery and is not supported. A complete scan is
bounded at 50,000 objects; larger deployments fail closed until the scanner is changed to persist a
resumable cursor and a stable scan generation.
