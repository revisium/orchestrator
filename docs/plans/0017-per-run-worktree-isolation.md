# Plan 0017 — Per-run git worktree isolation (developer + integrator)

**Status:** landed.

## Problem

Every step of a run executed in the **same on-disk working tree** — the target repo resolved from
`tasks.repo_ref` (`resolveRepoCwdFromRef`). The developer agent wrote **uncommitted** changes there and
the integrator then ran `git switch -c <branch> origin/<base>` + `git add -A` + commit + push from that
same tree. Two consequences:

1. **No concurrency on one repo** — two runs against the same repo raced on one working tree.
2. **The integrator's `git switch -c origin/<base>` failed on a dirty tree** — leftover uncommitted
   changes from a prior run aborted the switch (the concrete dogfood bug), and the user's base checkout
   was switched onto a `feat/...` branch and dirtied.

## Design

Each **live** run gets ONE isolated git worktree at `<dataDir>/worktrees/<runId>`, checked out on the
run's feature branch (`feat/<taskId>-<slug>`, the SAME branch the integrator computes) off a freshly-
fetched `origin/<base>`. Every repo-touching live effect (developer/rework steps + the integrator)
resolves its cwd to it; the base checkout is never mutated.

- **Lifecycle = the workflow (run level), not the runner.** `git-worktree-manager.ts` create/release are
  registered as memoized DBOS steps in `PipelineService`. The data-driven adapter creates the worktree
  AFTER a passing live preflight and BEFORE any effect, and releases it in a workflow-level `try/finally`
  around the graph — so release fires at EVERY terminal (succeeded/failed/blocked) **and** on a thrown
  adapter error (not `finish()`-only), but NOT while parked at a gate (`awaitHuman`/`recv` suspends the
  live workflow, so the body never returns there).
- **Location under the data dir**, NOT inside the target repo — a worktree inside the target would show
  as untracked in its `git status` and trip the next run's preflight clean check.
- **Two cwd resolvers** (`resolve-cwd.ts`): `makeResolveTaskCwd` (BASE checkout, keyed by taskId) for the
  preflight, which must run on the base repo BEFORE the worktree exists; `makeResolveRunCwd` (worktree-
  aware, keyed by runId) for the developer steps + the integrator. The run resolver **fails loud** for a
  live run whose worktree is missing (a `<runId>.live` marker is present but the worktree is gone) rather
  than silently falling back to the shared base checkout. Non-live (script/stub) runs resolve to the base.
- **Integrator keyed by runId, not taskId** — the worktree is per-RUN, so the integrator resolves cwd via
  the unambiguous `input.runId` (each run has a distinct runId; the prior `resolveTaskCwd(taskId)` could
  collide if the same task were ever re-run). Inside the worktree it is already on the feature branch, so
  its `branchExists→switch` path is a no-op and the dirty-tree `switch -c origin/<base>` is never taken.
  (In normal operation each `createRun` mints a distinct taskId too, as the J6 concurrency e2e asserts.)
- **Replay/recovery:** create is create-if-absent (idempotent; preserves in-flight uncommitted dev work
  across a crash); release no-ops if absent; the runId→path mapping is computed, not stored (preserves
  invariant #1 — the durable artifact is the pushed branch + DBOS progress).
- **node_modules** is best-effort symlinked from the base into the worktree, degrading gracefully when
  absent / not a Node target.

## Files

`src/worker/git-worktree-manager.ts` (new), `src/control-plane/resolve-cwd.ts` (run-aware resolvers +
path/marker helpers), `src/revisium/run.service.ts`, `src/runners/worktree.service.ts` (new),
`src/runners/integrator.ts` (resolve by runId; export `branchName`), `src/pipeline/data-driven-task.workflow.ts`
(lifecycle + try/finally), `src/pipeline/develop-task.workflow.ts` (register the two DBOS steps),
`src/runners/runner.module.ts`, `src/worker/claude-code-runner.ts` (per-step worktree hook removed).
Removed: the per-step `src/worker/worktree-manager.ts` + the stale `scripts/smoke-worktree-isolation.ts`.

## Tests

- Unit: `git-worktree-manager.test.ts` (create idempotency, branch-from-base, node_modules symlink +
  graceful absence, release), `resolve-cwd.test.ts` (run-aware: worktree present → worktree; marker +
  missing worktree → fail loud; non-live → base fallback).
- e2e: `concurrency.e2e.test.ts` **J6** (two concurrent LIVE runs on the SAME repo → distinct PRs/branches,
  base stays clean on master); `run-lifecycle.e2e.test.ts` updated (base checkout stays on master + clean;
  the branch + commit are pushed to origin from the worktree).

## Follow-up shipped — confirm-merge gates worktree cleanup on a real merge

The pipeline tail now ensures the worktree is reclaimed only once its branch is actually in the base:

```text
watcherRouter →(clean)→ mergeGate (human approve) →(approved)→ confirmMerge (script)
confirmMerge →(merged)→ mergedEnd        (succeeded → worktree released)
confirmMerge →(ScriptBlocked)→ blockedEnd (worktree KEPT for rework / manual merge)
confirmMerge →(ScriptFailed)→ failedEnd
```

- **`confirmMerge`** (`script:confirmMerge`, `integrator.ts`) is idempotent + gh-pinned: `gh pr view` →
  already `merged` (a human merged it) → succeed; else OPEN + `mergeStateStatus===CLEAN` (green CI, no
  conflicts) → `gh pr merge --squash --delete-branch` → re-view to confirm → succeed; otherwise block
  with a lesson. Merge method is `--squash` (default); per-node parameterization is a deferred task.
- **Cleanup semantics** (data-driven adapter `finally`): release the worktree on a **succeeded**
  terminal (PR merged → branch in base → disposable) and on a throw (failure); **KEEP** it on a
  **blocked** terminal so the developer can rework / merge manually in the same tree.
- Dispatch reuses the integrator's runner binding (real on live, stub on script). Built-in scripts
  (`script:integrator`, `script:confirmMerge`) resolve to the `integrator` required role.
- **pnpm provisioning**: `createRunWorktree` runs `pnpm install --frozen-lockfile` in the worktree for a
  pnpm repo (isolated + correct, cheap via the global store) instead of the shared `node_modules`
  symlink; non-pnpm repos keep the symlink fallback (graceful when absent).

## Follow-ups (deferred)
- **`cleanup_worktree` MCP tool + host-start orphan sweep** — explicit reclamation of a KEPT (blocked)
  or orphaned (cancel/crash) worktree, plus a best-effort `git worktree prune` + age-GC on host start.
  Keep-on-blocked means worktrees now accumulate for blocked runs until reclaimed.
- **Per-node run-time parameterization** (e.g. confirmMerge's merge method/policy) as run params.

- A data-model `lifecycle: { setup[], teardown[] }` template extension so worktree create/release become
  pipeline-expressed hooks (with `onTerminal`/`runOnWorkflowError`/`skipOnParkedGate`) rather than adapter-
  owned — needs engine support; adapter-owned is the smaller, safe choice for this slice.
- Orphan worktree sweep (`git worktree prune` + age-GC) on host startup for killed/abandoned runs.
