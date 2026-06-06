# Plan 0003 — Pipeline as a DBOS workflow (the core)

> **Status: Draft.** The heart of the MVP — the durable pipeline.
> **Depends on:** [0001](./0001-nest-host-and-dbos-bootstrap.md) · [0002](./0002-revisium-nest-module.md) ·
> [runner-contract.md](../runner-contract.md) · [context-budget.md](../context-budget.md).
> **Realizes:** invariant #2 (workflow as code for MVP), #3 (short-lived runners per step).

## Scope

Implement the pipeline **analyst → developer → reviewer → integrator** as a single DBOS workflow function. Each
step is a DBOS step that calls the existing `runAgent`. Prove the full chain end-to-end on the **stub runner**
(zero cost), with crash-resume.

## Non-goals

- No human gates yet (slice 0004).
- No real Claude/codex runner or real PR (slice 0005) — stub runner only here.
- No multi-repo / strategies (post-MVP).

## Files to create / change

- `src/pipeline/develop-task.workflow.ts` — `developTask(runId)`:
  - load run/task (RunService), then for each role: `runStep(role)`.
  - `runStep` = a DBOS step that: `RolesService.loadRole` → `loadModelProfile` → `buildContext` → `runAgent`,
    returns `AttemptResult`; persists output/cost to Revisium events/cost (draft writes) for audit.
  - reviewer → developer loop on BLOCKER/MAJOR, bounded (max iterations const).
- `src/pipeline/pipeline.module.ts` — provides the workflow + runner deps; registers the workflow with DBOS
  (instance-bound pattern from 0001).
- `src/engine/queue.ts` — a `WorkflowQueue('dev-tasks', { concurrency: N })`; `RunService.createRunWorkflow`
  enqueues `developTask` with workflow id = `runId` (idempotent start).
- CLI: `revo run start <id>` (or extend `run create` with `--start`) → enqueue the workflow.

## Reference code (reuse as-is)

- Runner contract + dispatch: `src/worker/runner.ts` (`RunAgent`, `AttemptResult`), `src/worker/runner-dispatch.ts`
  (`createRunAgent`).
- Stub runner: `src/worker/stub-runner.ts` (`stubRunAgent`).
- Context: `src/worker/build-context.ts` (`buildContext`).
- Result parsing (for real runners later): `src/worker/result-envelope.ts`.
- **Do not reuse** `src/worker/loop.ts` or the step-lifecycle verbs — DBOS replaces them.

## Notes

- The workflow holds the chain in code (MVP decision, ADR-0001 §5). Keep `runStep` generic so a later
  "execute plan" workflow can replace the hardcoded sequence with data-driven steps.
- Idempotency: workflow id = `runId`; each step's external effects (none on stub) keyed by step name + runId.

## Tasks

1. `runStep` DBOS step calling `runAgent` (dispatch → stub); persist an event per step to Revisium.
   **Verify:** a single `runStep('analyst')` runs the stub and writes an event.
2. `developTask` workflow chaining analyst→developer→reviewer→integrator with the bounded review→dev loop.
   **Verify:** `revo run create --start` runs the full chain on stub to completion; `revo run show` shows the
   step events in order.
3. Enqueue via `WorkflowQueue` with concurrency; idempotent start by `runId`.
   **Verify:** starting the same run twice does not double-run; two different runs proceed concurrently.

## Acceptance test

- A stub run goes analyst→developer→reviewer→integrator end-to-end via DBOS.
- Kill the process between two steps; restart → the workflow resumes at the next unfinished step (verified by the
  event sequence having no duplicates).
- `npm run lint:ci` + `tsc` clean.
