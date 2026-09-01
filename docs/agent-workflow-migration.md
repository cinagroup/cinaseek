# Agent orchestration: Workflow migration boundary

Moving the current agent loop into Cloudflare Workflows is not a mechanical wrapper change. The
loop currently executes inside `OverseerDurableObject`, and the object remains billably active
while any RPC, model request, or other I/O initiated by that call is still in flight. A Workflow
step that merely calls `overseer.runAgent()` therefore adds Workflow requests, steps, and storage
without removing Durable Object duration.

This document is the implementation boundary for the later migration. The current release keeps
the agent loop in the Overseer and bounds it with `AGENT_MAX_TURNS`, `AGENT_MAX_DURATION_MS`, and
pre-charge quota reservations. Do not add a Workflow binding until the state-machine acceptance
criteria below can be met.

References:

- <https://developers.cloudflare.com/workflows/build/workers-api/>
- <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>
- <https://developers.cloudflare.com/workflows/reference/limits/>
- <https://developers.cloudflare.com/workflows/reference/pricing/>

## Target ownership

The Overseer remains authoritative for chat order, code state, capability checks, quota ledgers,
and the step persistence barrier. The Workflow owns only serializable orchestration state:

```text
executionId, workspaceId, chatId, initiatorUserId, modelId,
callbackInitiated, turnNumber, expectedChatRevision, cancellationEpoch
```

It must never persist API tokens, OAuth credentials, RPC stubs, attachment bodies, prompts, model
responses, or tool results in Workflow parameters or step outputs. Workflow event and step output
limits are 1 MiB; large durable payloads belong in the already-authorized workspace DO or the
workspace R2 prefix.

## Required state machine

1. In one Overseer transaction, validate the chat, reserve the funded allowance, allocate a random
   `executionId`, persist the active execution record, and expose `activeAgent` to clients.
2. Create the Workflow instance with `executionId` as its stable instance ID. Creation retries must
   reuse that ID.
3. A short `prepare` RPC reads an immutable turn snapshot and expected chat revision. The Workflow
   reacquires model credentials through the initiator's existing User DO capability in memory;
   credentials never become a step result.
4. Run one model request outside the Overseer. Provider idempotency must be keyed by
   `executionId/turnNumber`; where a provider cannot guarantee idempotency, configure this step
   with no automatic retry and surface an explicit uncertain-charge outcome.
5. Persist the complete model result under the execution ledger before any tool effect. Streaming
   deltas are best-effort realtime events with monotonic sequence numbers, not the durable result.
6. Execute tools through narrow, individually authorized Overseer RPCs. Each mutating tool carries
   `executionId`, `turnNumber`, and a deterministic call ID. Replays return the recorded result.
7. Commit the assistant transcript and buffered code/binding effects through the existing atomic
   `commitAgentStep` barrier, guarded by the expected chat revision and deterministic step ID.
8. Repeat from model request until completion, configured turn limit, connection/action wait, or
   cancellation. Waiting for approval uses a Workflow event; it must not retain an Overseer RPC.
9. Terminal cleanup settles/releases quota exactly once, clears `activeAgent`, emits the finish
   event, and makes a duplicate terminal callback a no-op.

## Cancellation and recovery

- `stopAgent` first writes a cancellation tombstone in the Overseer, then terminates the Workflow
  instance. Every tool and commit RPC checks the tombstone, so an already-running step cannot
  commit after cancellation.
- Constructor-based `activeAgents` resumption remains enabled during migration. Records with no
  Workflow ID use the legacy resumer; records with one reconcile Workflow status and never start a
  second local loop.
- Workflow retries may repeat reads but not external charges or writes. Every mutation needs a
  deterministic ledger key and an atomic “apply once” transaction in the owning DO.
- Callback turns are the final cohort: transient callback stubs cannot cross Workflow suspension.
  They require a durable callback mailbox or must remain on the bounded legacy runner.

## Release gates

- [ ] Unit tests cover duplicate Workflow creation, duplicate model completion, duplicate tool
  calls, stale chat revisions, cancellation races, and terminal callback replay.
- [ ] Chaos tests terminate the Workflow before and after every persistence barrier and prove one
  transcript/effect and at most one billed provider request per turn.
- [ ] Prompt, response, and attachment sizes above 1 MiB complete without entering Workflow state.
- [ ] Secrets are absent from Workflow parameters, outputs, logs, traces, and error messages.
- [ ] A canary shows lower `OverseerDurableObject` GB-s per agent minute after adding Workflow
  request/step/storage cost. A rollout that only moves cost between meters does not advance.
- [ ] Stop latency is below five seconds and no cancelled execution commits a later tool effect.
- [ ] Legacy resumption remains the rollback path for records created before the Workflow flag.

Until all gates pass, `AGENT_MAX_TURNS` and `AGENT_MAX_DURATION_MS` are the supported commercial
cost controls. A cosmetic Workflow wrapper is explicitly prohibited.
