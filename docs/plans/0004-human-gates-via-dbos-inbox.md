# Plan 0004 — Human gates via DBOS + Revisium inbox

> **Status: Draft.** Adds the two mandatory human stops to the durable pipeline.
> **Depends on:** [0003](./0003-dbos-pipeline-workflow.md) · [inbox-and-gates.md](../inbox-and-gates.md) ·
> [0002](./0002-revisium-nest-module.md) (InboxService).
> **Realizes:** invariant #5 — a human decision is a state change that resumes a parked workflow.

## Scope

Park the workflow at the **plan gate** (after analyst) and the **merge gate** (after the integrator opens the PR):
write an inbox row in Revisium, then durable-wait for the human's decision via `DBOS.recv`. `revo inbox resolve`
signals the workflow via `DBOS.send`. Agents never merge.

## Non-goals

- No proactive `routing_policy`-driven gates (post-MVP); only the two hardcoded gates.
- No auto-reply to live reviewers (post-MVP).

## Mechanic

```text
workflow developTask(runId):
  ...analyst step...
  await awaitHuman(runId, 'plan', summary)   // pushInbox(Revisium) → DBOS.recv(runId, 'plan')
  if rejected: end run (status cancelled)
  ...developer/reviewer/integrator...
  await awaitHuman(runId, 'merge', prUrl)    // pushInbox → DBOS.recv(runId, 'merge')
  // human merges externally; agents never merge
```

```text
revo inbox resolve <id> --approve|--reject:
  InboxService.resolveInbox(...)             // record decision on the Revisium inbox row (existing)
  DbosService.signal(runId, topic, decision) // DBOS.send → wakes the parked workflow next turn
```

## Files to create / change

- `src/pipeline/await-human.ts` — `awaitHuman(runId, topic, context)`: `InboxService.buildInboxRow` + write
  (draft) → `DBOS.recv(runId, topic)`; returns the decision.
- `src/pipeline/develop-task.workflow.ts` — insert the two `awaitHuman` calls; handle reject.
- `src/engine/dbos.service.ts` — add `signal(workflowId, topic, payload)` wrapping `DBOS.send`.
- CLI `inbox resolve` — after `resolveInbox`, call `DbosService.signal`.

## Reference code (reuse)

- `src/control-plane/inbox.ts` (`buildInboxRow`, `listInbox`, `resolveInbox`) — wrapped by `InboxService` (0002).
- DBOS `send`/`recv` semantics — see [adr/0001](../adr/0001-execution-engine-and-host.md) and docs.dbos.dev.

## Tasks

1. `awaitHuman` + DBOS `recv`/`send` wiring; topic = gate name, keyed by `runId`.
   **Verify:** a run parks at the plan gate; `revo inbox list` shows one pending approval; the workflow is
   suspended (no CPU, survives restart).
2. `inbox resolve --approve` resumes; `--reject` ends the run.
   **Verify:** approve → workflow proceeds to developer; reject → run status `cancelled`, no further steps.
3. Merge gate after integrator (uses slice 0005's PR url; on stub, a placeholder url).
   **Verify:** run parks at merge gate after the integrator step; resolve does not auto-merge.

## Acceptance test

- Full stub run: parks at plan gate → approve → runs to integrator → parks at merge gate.
- Restart the process **while parked**; the gate is still pending and resolvable after restart (durability).
- Reject at the plan gate cancels the run cleanly.
- `npm run lint:ci` + `tsc` clean.
