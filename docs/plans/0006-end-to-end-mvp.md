# Plan 0006 — End-to-end MVP + getting-started

> **Status: Draft.** Ties the slices into one command and dogfoods the orchestrator on itself.
> **Depends on:** [0001](./0001-nest-host-and-dbos-bootstrap.md)–[0005](./0005-real-runners-and-integrator.md).
> **Realizes:** the MVP acceptance criterion — one run from `create` to an open PR with human gates.

## Scope

Make a single `revo` invocation boot the whole system (host → ensure Revisium → DBOS → ready), run a ticket
through the durable pipeline with both human gates, and open a PR. Rewrite `getting-started.md` for the two-process
model. Prove it by having the orchestrator make a trivial real change to **agent-orchestrator itself** (dogfood).

## Non-goals

- No new mechanisms — this slice integrates and documents.

## Files to create / change

- `src/cli/program.ts` — a top-level flow: `revo work <runId>` (or `revo run create --start --wait`) that boots
  the host and drives the run, surfacing gate prompts.
- `docs/getting-started.md` — **rewrite**: prerequisites, `revo revisium start`, `revo run create --start`,
  `revo inbox list/resolve`, the two-process / one-Postgres model, where DBOS state lives.
- `scripts/smoke-mvp.ts` — a smoke run on the stub runner (no external calls) for CI confidence.

## Reference

- All prior slices; `src/config.ts` for ports/health; existing smoke-script pattern in `scripts/`.

## Tasks

1. End-to-end flow command + gate prompts.
   **Verify:** from a clean machine, `revo revisium start` then `revo run create --start` boots host+DBOS and runs.
2. Rewrite `getting-started.md`; remove pre-pivot loop/`revo work` polling references.
   **Verify:** a new reader can follow it start-to-PR.
3. `scripts/smoke-mvp.ts` — stub end-to-end, asserts the event sequence and gate parks.
   **Verify:** `npm run smoke:mvp` green.

## Acceptance test (the MVP bar)

- Dogfood: create a run that makes a trivial real change to agent-orchestrator (e.g. a doc typo or a comment),
  runs analyst→developer→reviewer→integrator, parks at plan + merge gates, and opens a real draft PR. A human
  merges.
- Kill + restart at any point → the run resumes; no duplicated steps or PRs.
- `npm run lint:ci` + `tsc` + `npm test` + `npm run smoke:mvp` clean.
