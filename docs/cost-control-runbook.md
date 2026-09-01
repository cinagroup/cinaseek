# Cost-control rollout and incident runbook

This is the operational checklist for the lifecycle and billing changes described in
`docs/cost-control.md`. Each stage has its own switch or deployment boundary. Do not combine stages
in one canary: attribution and rollback become ambiguous.

## Release prerequisites

- [ ] Reconcile at least 14 representative days of Cloudflare usage with the product events in
  `docs/cost-control.md`; attributed daily cost must be within 15% of the invoice.
- [ ] Export the current account-specific rates and inclusions into a capacity-model JSON file.
  Run `node scripts/cost-control/capacity-model.mjs <input.json>` and archive the output with the
  release evidence. Never copy rates into application source.
- [ ] Confirm dashboards split production/canary and identify Durable Object namespace, Worker,
  Workflow, R2 bucket, AI funding route, and feature-flag cohort.
- [ ] Confirm alerts route to an owner who can disable UI flags and change
  `WORKSPACE_BLOB_MODE` without deploying code.
- [ ] Run `pnpm lint`, `pnpm build`, `pnpm test`, and the release-manifest golden test.
- [ ] Record the previous release ID and current values of `workspace-idle-suspension`,
  `realtime-presence`, `REALTIME_CONSOLE_ENABLED`, `WORKSPACE_BLOB_MODE`, and
  `REALTIME_TICKET_SECRET` availability, plus `AGENT_MAX_TURNS` and
  `AGENT_MAX_DURATION_MS`.

## Stage A — idle suspension

- [ ] Deploy with `workspace-idle-suspension` off and verify no lifecycle change.
- [ ] Enable for internal accounts, then 1%, 10%, 50%, and 100% of sessions.
- [ ] Hold each cohort for at least one peak traffic window.
- [ ] Verify hidden sessions release after 90 seconds and visible idle sessions after five minutes.
- [ ] Verify sessions do not release during agent execution, attachment send/upload, or pending OT
  edits, and that the next user activity restores metadata and subscriptions.
- [ ] Abort if workspace reopen errors exceed 0.5%, p95 reopen latency regresses by more than 20%,
  or reports show lost drafts/attachments.
- [ ] Roll back by disabling `workspace-idle-suspension`.

## Stage B — hibernatable realtime

- [ ] Install a deployment-unique `REALTIME_TICKET_SECRET` containing at least 32 random bytes on
  every backend version before enabling the flag.
- [ ] Verify invalid signatures are rejected before a realtime Durable Object is addressed,
  expired tickets return 401, and ticket replay returns 409.
- [ ] Enable `realtime-presence` for internal accounts, then 1%, 10%, 50%, and 100%.
- [ ] During mixed-version rollout, compare the legacy and realtime rosters. Abort above 0.1%
  divergence, above 0.5% handshake failures, or any cross-workspace participant disclosure.
- [ ] Verify realtime objects hibernate with connected idle sockets and that Overseer active
  duration falls for app-only viewers.
- [ ] After presence is stable, set `REALTIME_CONSOLE_ENABLED=true` only on the canary backend.
  Verify build-role clients receive mainline and preview logs, use-role tickets are rejected, and
  malformed events do not close the browser channel.
- [ ] Compare console delivery with the legacy RPC feed during the canary. Abort on cross-workspace
  disclosure or sustained missing/duplicate events above 0.1%.
- [ ] Roll console back first by clearing `REALTIME_CONSOLE_ENABLED`; clients automatically use the
  RPC feed. Roll presence back by disabling `realtime-presence`; leave non-authoritative realtime
  storage in place until the release is declared stable.

## Stage C — workspace blobs

- [ ] Provision the `WORKSPACE_BLOBS` bucket and deploy with mode unset/`disabled`; verify legacy
  DO-only attachment behavior is unchanged, then set `mirror` only for the canary cohort.
- [ ] Set and record `WORKSPACE_ATTACHMENT_LIMIT_BYTES` and
  `WORKSPACE_ATTACHMENT_LIMIT_COUNT`; test rejection at both boundaries before enabling R2 writes.
- [ ] Verify every new staged attachment has both a DO body and an R2 object, and exercise image
  history hydration, non-image download, agent attachment input, staged deletion, chat deletion,
  and workspace deletion.
- [ ] Alert on any `chat.attachment.r2.mirror.failed` event. Do not advance with mirror errors.
- [ ] After one full attachment retention window, switch 1% of workspaces to `r2`, then 10%, 50%,
  and 100%. Track R2 Class A/B operations, bytes, DO stored bytes, and attachment-read latency.
- [ ] Abort on any unavailable attachment, deletion error, or p95 read regression above 20%.
- [ ] Application rollback is `WORKSPACE_BLOB_MODE=disabled`. Do not remove the production binding;
  it is part of the release manifest and remains necessary to read bodies written in `r2` mode.

## Stage D — Dynamic Workers

- [ ] Compare `dynamic_worker_requested.worker_id` distinct counts before and after deployment,
  split by mainline/preview and workspace.
- [ ] Verify ordinary chat messages do not change preview worker IDs, an unrelated gadget commit
  does not change another gadget's ID, and binding/code changes do change the affected ID.
- [ ] Abort if a worker serves code or bindings from another revision; roll back the release, since
  this identity scheme is not feature-flagged.

## Stage E — quota reservations

- [ ] Start two requests concurrently with one free call remaining; exactly one must reserve it.
- [ ] Verify a failure before inference releases the reservation and a provider failure after
  inference starts consumes it.
- [ ] Verify funded BYOK runs create no platform reservation.
- [ ] Alert when a reservation remains active past the maximum supported agent-run duration; this
  is fail-closed spend protection but requires investigation.
- [ ] Confirm the profile usage panel shows active reservations and remaining allowance.
- [ ] Exercise the configured turn and duration ceilings. Confirm timeout is a distinct analytics
  outcome, the model request is aborted, provisional effects are reconciled, and the reservation
  is settled according to whether inference started.
- [ ] Do not enable a Workflow migration until every gate in
  `docs/agent-workflow-migration.md` passes and canary accounting shows a net COGS reduction.

## Alert set

- [ ] Durable Object GB-s per active workspace +30% over the seven-day same-hour baseline.
- [ ] Workspace session finish/start ratio below 95% for 30 minutes (investigate crashes; billing
  remains based on Cloudflare metrics, not the event pair).
- [ ] Realtime ticket configuration errors or cross-workspace mismatch: page immediately.
- [ ] Realtime handshake failure above 0.5% for 15 minutes.
- [ ] R2 mirror failures above zero, R2 deletion failures above zero, or workspace blob bytes
  growing without matching committed attachment metadata.
- [ ] Daily distinct Dynamic Worker count +25% week over week without a matching increase in
  edited gadget revisions.
- [ ] Agent `usage_limit` outcomes +50% over baseline or active quota reservations older than the
  supported run duration.
- [ ] Cost per successful agent run or per interactive workspace hour +20% over the seven-day
  baseline for two consecutive hours.

## Evidence and completion

- [ ] Save build/test results, canary timestamps, dashboard snapshots, configuration values (never
  secret contents), and rollback owner for every stage.
- [ ] Keep flags dark for one release before deleting any legacy read path.
- [ ] Delete legacy data only through a separately reviewed migration with measured object counts,
  a dry-run mode, bounded batches, and a resumable cursor.
