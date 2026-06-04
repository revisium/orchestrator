# Plan 0015 — Per-run git worktree isolation (realize runner-contract §Isolation)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** give each step's agent its own `git worktree` — an isolated working tree
> off the shared `.git` — so parallel workers cannot collide and a step's stray uncommitted work
> cannot bleed into another step's working tree. Note: under per-step worktrees with **no
> merge-back**, every step (including the integrator) starts from a fresh worktree off `HEAD`;
> the integrator does **not** inherit a prior developer step's uncommitted files — each step sees
> only what is already committed. Realized as an **injectable `WorktreeManager`** in the existing
> `ClaudeCodeRunnerDeps` seam; the loop, the `revo work` wiring, and the `resolveCwd`
> path-traversal guard require only additive changes.
>
> **Out of scope:**
> - Container / VM isolation (heavier; a later hardening pass).
> - Multi-repo tasks and per-clone isolation across repos — Plan 0010 (`docs/multi-repo-strategies.md`).
> - Codex runner — deferred in Plan 0008.
> - Inbox / approval resolution — Plan 0009.
> - Expired-lease reaping and multi-worker atomicity.

---

## 0. Context you must read first

- `docs/runner-contract.md` line 20 — "run in a fresh clone / container, with only the tools in
  `role.allowed_tools` enabled" (the isolation intent this plan realizes).
- `src/worker/claude-code-runner.ts` lines 17–22 — `ClaudeCodeRunnerDeps` type: the `resolveCwd`
  injection point; line 81 — `const cwd = await deps.resolveCwd(step);`.
- `src/cli/commands/work.ts` lines 42–61 — `makeResolveCwd`: `base = process.cwd()`, path-traversal
  guard (`resolved.startsWith(base + sep)`).
- `src/worker/loop.ts` lines 18–37 — `processClaimedStep`; lines 40–71 — `handleResult` (success and
  failure paths that must both trigger worktree teardown).
- `.gitignore` — `node_modules/` and `dist/` are gitignored; a fresh worktree has neither.
- `package.json` scripts `typecheck`, `lint:ci`, `test` (all require `node_modules`; `typecheck` and
  `lint:ci` also use compiled `dist` if present).
- `docs/plans/0008-claude-code-runner.md` design decision 3 — "`resolveCwd` is injected; per-repo
  clone/container isolation is Plan 0010" (note: container isolation stays deferred; worktree
  isolation is the intermediate step).

Key facts:

1. `ClaudeCodeRunnerDeps.resolveCwd` (line 17 of `claude-code-runner.ts`) is the injection seam: the
   runner calls it once, gets a `cwd`, and passes it to the executor. Adding a `WorktreeManager`
   dependency that wraps/follows this call adds lifecycle without touching the loop or the
   executor.
2. `node_modules/` and `dist/` are gitignored (`cat .gitignore`). A fresh `git worktree add` produces
   no gitignored paths — they must be provided explicitly. `node_modules/` is symlinked so tools
   like `typecheck` and `test` work without a full `npm ci`. `dist/` is intentionally **not**
   symlinked (see Step 2, point 5 rationale).
3. Gates (`npm run typecheck`, `npm run lint:ci`, `npm run test`) read from `node_modules/` but do not
   write to it. Symlinking the main workspace's `node_modules/` into each worktree is safe for a
   single-worker sequential loop and avoids a full `npm ci` per run (which would be slow and wasteful).
4. The path-traversal guard in `makeResolveCwd` validates `repo_ref`-derived paths — it runs on
   the value of `step.input.repo_ref` and resolves it against the base directory. It does **not**
   validate worktree paths. `GitWorktreeManager` independently keeps the worktree inside the git
   root by construction: `create` always produces `<gitRoot>/.worktrees/<stepId>`, which is rooted
   at the git root. These are two separate safety mechanisms; neither relies on the other.
5. The loop does not need to know about worktrees. Lifecycle (create before executor, release after)
   belongs entirely inside the runner via a `try/finally`.

---

## 1. `WorktreeManager` interface and no-op default

**Files to create:**

- `src/worker/worktree-manager.ts`

**Implementation notes:**

Define the lifecycle contract:

```ts
export type WorktreeManager = {
  // Create an isolated working tree for this step rooted at baseDir.
  // Returns the absolute path the runner must use as cwd.
  create(stepId: string, baseDir: string): Promise<string>;
  // Release (remove) the working tree at worktreePath.
  release(worktreePath: string): Promise<void>;
};

// Default: no isolation — returns baseDir unchanged, release is a no-op.
// Used by the existing --runner stub path and in unit tests.
export const noopWorktreeManager: WorktreeManager = {
  async create(_stepId, baseDir) { return baseDir; },
  async release(_worktreePath) {},
};
```

The interface must not import from control-plane tables (invariant 4). `stepId` is the only identity
passed from the runner; it must not require any additional control-plane lookups.

**Verify:**

```bash
npm run typecheck
```

**Stop conditions:**

- If the interface needs to accept additional runner context (e.g. `runId`), derive it from `stepId`
  or from the path returned by `create` — do not add control-plane calls here.

---

## 2. `GitWorktreeManager` implementation

**Files to create:**

- `src/worker/git-worktree-manager.ts`
- `src/worker/git-worktree-manager.test.ts`

**Implementation notes:**

`create(stepId, baseDir)`:

1. Locate the git root: `git -C <baseDir> rev-parse --show-toplevel` (spawn via `node:child_process`
   `execFileSync` or a helper; do NOT use the `ProcessExecutor` injection — that is for the claude
   runner only). Throw if `baseDir` is not inside a git repo.
2. Choose the worktree path: `<gitRoot>/.worktrees/<stepId>`. The `.worktrees/` directory is gitignored
   (Step 4 adds the entry); each step gets its own subdirectory named by `stepId`.
3. Create the worktree: `git -C <gitRoot> worktree add <worktreePath> -b run/<stepId> HEAD`. This
   creates the branch `run/<stepId>` off `HEAD` and checks it out in the new working tree. If a
   worktree or branch with that name already exists (retry after a crash), remove the stale entry
   first (see `release`).
4. Symlink `node_modules`: `ln -sf <gitRoot>/node_modules <worktreePath>/node_modules` (use
   `node:fs.symlinkSync`). If `<gitRoot>/node_modules` does not exist, skip silently (a
   `typecheck`/`test` failure in the agent will surface the missing dep more clearly than a setup
   crash).
5. Do **not** symlink `dist/`. Rationale: `dist/` is a writable build output directory. A developer
   agent running `npm run build` inside the worktree would write through a symlink directly into the
   main workspace's `dist/` — clobbering any running build and affecting every concurrent worker.
   This is a risk today (even with a single sequential worker), not just under parallelism. Instead,
   let each worktree's own build produce an isolated `dist/` inside the worktree. If no build has
   run inside the worktree, `typecheck` and `lint:ci` will work because they use `ts-node`/`tsx`
   directly (not compiled `dist/`); only scripts that import from `dist/` would need a local build
   first. The agent step can run `npm run build` in its worktree `cwd` if needed.
6. Return `worktreePath`.

`release(worktreePath)`:

1. Determine the git root: `git -C <worktreePath> rev-parse --show-toplevel` (same helper as `create`).
2. Remove the worktree: `git -C <gitRoot> worktree remove --force <worktreePath>`. `--force` is
   required because the agent may have left uncommitted changes (the developer role writes code but
   does not commit; the integrator commits on a separate step).
3. Delete the branch: `git -C <gitRoot> branch -D run/<stepId>` — derive `stepId` from the final
   segment of `worktreePath`. Treat a missing branch as a no-op (it may have been pushed and deleted).
4. If `worktreePath` still exists after step 2 (e.g. the `worktree remove` failed), delete it with
   `rm -rf <worktreePath>` as a fallback. Log a warning; do not throw.

Unit tests (a real temporary git repo is required — `GitWorktreeManager` makes actual
`git worktree add` / `git worktree remove` calls; use `git init` in a temp directory):

- `create` creates a directory at the expected path and symlinks `node_modules`.
- `release` removes the directory and the `run/<stepId>` branch.
- `release` on a non-existent path does not throw.
- A simulated retry (call `create` twice with same `stepId`) cleans up the stale entry first.

Interface-only tests that need no git repo belong in the Step 1 file
(`worktree-manager.ts` / the `noopWorktreeManager`) — not here.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- If `git worktree add` rejects because the git version is too old (worktrees require git ≥ 2.5),
  **stop and report** — add a minimum git version check in `create` and note the constraint.
- Do not modify `ProcessExecutor` or `claude-code-runner.ts` in this step. The `GitWorktreeManager`
  uses its own sync/async spawn calls, separate from the runner's executor seam.

---

## 3. Wire `WorktreeManager` into `ClaudeCodeRunnerDeps`

**Files to change:**

- `src/worker/claude-code-runner.ts`

**Implementation notes:**

Current `ClaudeCodeRunnerDeps` (lines 17–22):

```ts
export type ClaudeCodeRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>;
  timeoutMs?: number;
  command?: string;
};
```

Add one optional field:

```ts
worktreeManager?: WorktreeManager;  // default: noopWorktreeManager
```

In the returned `runAgent` (starting at line 79), currently:

```ts
const cwd = await deps.resolveCwd(step);
```

Wrap with `try/finally` for lifecycle:

```ts
const baseCwd = await deps.resolveCwd(step);
const manager = deps.worktreeManager ?? noopWorktreeManager;
const cwd = await manager.create(step.id, baseCwd);
try {
  // ... existing ExecRequest assembly, executor call, result parsing ...
  return success; // or return parked;
} finally {
  await manager.release(cwd);
}
```

The `try/finally` must wrap **all** exit paths (success, `needsHuman`, timeout throw, parse-error throw)
so the worktree is always cleaned up. The runner's error-throw path is already caught by the loop's
`processClaimedStep` → `failStep`; the `finally` runs before the throw propagates.

No other changes to the runner. The executor receives the worktree `cwd`; the result-parsing, cost
building, and `AttemptResult` assembly are unchanged.

**Verify:**

```bash
npm run typecheck
npm test
```

Extend the existing unit tests in `claude-code-runner.test.ts` (without touching existing assertions):

- Inject a spy `WorktreeManager`; assert `create` is called with `step.id` and the `baseCwd` returned
  by `resolveCwd`; assert `release` is called with the path returned by `create`.
- Simulate `manager.create` throwing; assert the runner propagates the error and does NOT call
  `release` (no double-release on creation failure).
- Simulate a runner parse error; assert `release` is still called (`finally` fires on throw).

**Stop conditions:**

- Do not remove or change the `resolveCwd` field. `WorktreeManager` is additive; `resolveCwd` remains
  the base-directory resolver (it resolves `repo_ref` against the workspace — the worktree wraps that
  result).
- If the `finally` pattern requires restructuring the runner's `if (result.timedOut)` / `if
  (result.code !== 0)` branches, keep each early `throw` inside the `try` block so `finally` fires.

---

## 4. Add `.worktrees/` to `.gitignore`

**Files to change:**

- `.gitignore`

**Implementation notes:**

Append one line:

```text
.worktrees/
```

This prevents ephemeral worktree directories from appearing as untracked changes on the main working
tree. The `.git/worktrees/` metadata directory (inside `.git`) is handled by git itself and does not
need a gitignore entry.

**Verify:**

```bash
git check-ignore -v .worktrees/anything
```

Should print the new `.gitignore` rule.

**Stop conditions:**

- If `.worktrees/` is already present (future state), skip — do not duplicate.

---

## 5. Opt-in wiring in `revo work`

**Files to change:**

- `src/cli/commands/work.ts`

**Implementation notes:**

Add a `--worktrees` boolean flag (default `false`) to `workCommand`:

```bash
revo work --runner auto --worktrees
```

When `--worktrees` is true and `runnerMode === 'auto'`, inject a `GitWorktreeManager` instance into
`createClaudeCodeRunner`:

```ts
createClaudeCodeRunner({
  executor: spawnExecutor,
  resolveCwd: makeResolveCwd(da),
  timeoutMs: runnerTimeoutMs,
  worktreeManager: options.worktrees ? new GitWorktreeManager() : undefined,
})
```

When `--worktrees` is false or `runnerMode === 'stub'`, the field is omitted and the runner defaults
to `noopWorktreeManager` — the default stub behavior is unchanged.

Guard: if `--worktrees` is passed with `--runner stub`, print a warning
(`"--worktrees has no effect with --runner stub"`) and continue; do not error.

The `makeResolveCwd` path-traversal guard validates `repo_ref`-derived paths and is unaffected by
this change. `GitWorktreeManager` independently keeps worktree paths inside the git root by
construction — no guard modification is needed and the guard does not validate worktree paths
(see §0 Key fact 4).

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- work --help  # must list --worktrees
```

**Stop conditions:**

- Do not change `runWorker` or `WorkerDeps` (invariant 2: the loop stays runner-agnostic).

---

## 6. Smoke test: worktree lifecycle

**Files to create:**

- `scripts/smoke-worktree-isolation.ts`
- Add `"smoke:worktree-isolation": "tsx scripts/smoke-worktree-isolation.ts"` to `package.json`

**Implementation notes:**

The smoke verifies the lifecycle end-to-end with a real git repo and a fake executor (zero tokens):

1. Create a temp directory and `git init` it (or use the repo root itself).
2. Instantiate `GitWorktreeManager`.
3. Call `create(stepId, baseDir)` — assert: the returned path exists, is a valid git working tree,
   and `node_modules` is a symlink pointing to the main workspace's `node_modules`.
4. Call `release(returnedPath)` — assert: the path no longer exists and the `run/<stepId>` branch is
   deleted.
5. Create a `ClaudeCodeRunner` with a fake executor that returns a valid `REVO_RESULT` envelope, inject
   the `GitWorktreeManager`, run one step — assert: the executor received a `cwd` inside `.worktrees/`,
   the worktree is gone after the run.
6. Simulate a runner parse error (fake executor returns invalid JSON) — assert: worktree is still
   cleaned up (the `finally` fires even on throw).

Exit 0 on all assertions passing; print clear PASS/FAIL per sub-step.

**Verify:**

```bash
npm run build
npm run smoke:worktree-isolation
```

**Stop conditions:**

- This smoke is kept outside `npm test` (it touches the real filesystem and git). It must not require
  a running Revisium daemon.

---

## 7. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
npm run typecheck
npm run lint:ci
npm test
npm run revo -- work --help      # lists --worktrees
npm run build
npm run smoke:worktree-isolation
git diff --check
```

**Slice is done when:** `GitWorktreeManager` creates an isolated working tree per step, symlinks
`node_modules` from the main workspace, tears down the tree in a `try/finally` regardless of success
or failure, the runner's existing `AttemptResult` contract is unchanged, the loop and `WorkerDeps`
are untouched, the stub path (no `--worktrees`) is unaffected, all unit and smoke tests pass, and
`git diff --check` is clean.

---

## Known gaps — git-level isolation only (NOT for parallel)

Worktrees provide **git-level isolation** (clean staging area, isolated branch and working tree per step) but no resource isolation. Three specific dangers must be understood before using `--worktrees` for parallel or resource-sensitive workloads:

1. **`npm install` / `npm ci` inside a worktree writes through the `node_modules` symlink into the main workspace's `node_modules`**, corrupting the shared install for every other concurrent or subsequent run. §0 key fact 3 describes the symlink as "safe for a single-worker sequential loop" but does not name this danger explicitly. Do NOT run `npm install` or `npm ci` inside a worktree; install dependencies in the main workspace only, before starting the worker loop.

2. **Parallel test-environment tasks will collide on shared ports.** The Revisium daemon and Postgres are process/host-level resources whose ports are resolved at runtime via the `revo` CLI / `~/.revisium-orchestrator/runtime.json`; they are not isolated per worktree. Two runs that each try to start the daemon will fight over whatever the active ports are. Worktrees give zero port or process isolation.

3. **The real fix for parallel or resource-isolated runs is container/VM-level isolation**, not worktrees. Worktrees isolate the git working tree only. Container/VM isolation is tracked as a later hardening pass and is already noted under §8 deferred / "Needs human" below.

4. **Worktree mode discards a step's on-disk work on release — there is no merge-back.** `release()` runs `git worktree remove --force` then `git branch -D run/<stepId>`; the runner consumes only the JSON result envelope and never commits, merges, or copies the worktree's file or git changes back before teardown. Any uncommitted file changes a step produces (for example, the developer role, which leaves code uncommitted for the integrator) are force-deleted when the step ends. `--worktrees` is only safe for steps that either (a) return results purely via the JSON envelope, or (b) commit and push within the step. The developer-writes → integrator-commits cross-step handoff **requires** the default single-tree mode — do **not** pass `--worktrees` for it. A merge-back / export mechanism is deferred (see §8).

---

## 8. Report back / open findings

Report:

1. `WorktreeManager` interface, no-op default, and `GitWorktreeManager` implementation summary.
2. Worktree path convention (`.worktrees/<stepId>`), branch naming (`run/<stepId>`), and `node_modules`
   symlink strategy with rationale.
3. How `try/finally` in the runner covers all exit paths (success, `needsHuman`, timeout, parse error).
4. Confirm path-traversal guard is unmodified and worktree paths still satisfy it.
5. Validation: typecheck, lint, test, smoke output.
6. Confirm `--runner stub` default is unaffected; worktrees are opt-in via `--worktrees`.

Open findings / deferred:

- **Container / VM isolation** — a harder boundary; deferred as a later hardening pass.
- **Multi-repo** (Plan 0010) — separate concern; worktree isolation and multi-repo strategies compose
  but are designed independently.
- **Branch cleanup on crashed workers** — if the worker is killed mid-run (SIGKILL), the `finally`
  does not run. A separate reaper (`git worktree list --porcelain` + prune) is a follow-up.
- **Parallel workers** — the current loop is single-worker/sequential; parallel workers sharing `.git`
  through separate worktrees are safe for git, but the branch namespace (`run/<stepId>`) must remain
  unique (it is, since `stepId` is a UUID-derived key).

Needs human / ADR sign-off:

- Switching `--worktrees` to default-on (cost: disk + git-prune setup).
- Container/VM boundary if regulatory requirements mandate it.
