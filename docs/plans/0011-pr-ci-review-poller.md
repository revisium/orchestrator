# Plan 0011 — PR / CI / review poller (deterministic wait + LLM-judge split)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** replace the single-pass `pr-watcher` `claude -p` run (which fires too early
> and misses pending CI / Sonar / CodeRabbit threads) with a **two-phase design**:
> (1) a deterministic, zero-LLM poller step that calls `gh api` / Sonar once per invocation and
> re-queues itself via `run_after` until checks are terminal; (2) a bounded human-fallback when
> the retry cap is reached; and (3) an LLM judge step that receives the pre-gathered, structured
> findings and classifies only free-text human/bot comments. The loop is not changed; the
> re-queue mechanism uses the existing `run_after` + `nextSteps` path already implemented in
> `src/control-plane/steps.ts:181`.
>
> **Out of scope:**
> - GitHub commit automation and `git commit`/`git push` from agents — a separate concern.
> - Idempotent external creates keyed on `attemptId` (referenced in Plan 0008 open findings).
> - Inbox / approval resolution UI — Plan 0009.
> - Multi-repo strategies — Plan 0010.
> - Routing-policy evaluation and multi-worker lease reaping.
> - Renaming `pr-watcher` to `pr-judge` — a separate ADR + migration; the role name stays
>   `pr-watcher` throughout this plan.

---

## 0. Context you must read first

- `control-plane/bootstrap.config.json` lines 639–651 — current `pr-watcher` role: `runner:
  "claude-code"`, `model_level: "cheap"`, `allowed_tools: ["Read", "Bash"]`, single-pass
  `system_prompt` (does not wait for CI).
- `docs/control-plane-schema.md` lines 49–54 — `steps` table: `run_after` (ISO string), `status`
  states including `awaiting_approval`; `input`/`output` are serialized JSON strings.
- `docs/control-plane-schema.md` lines 64–68 — `inbox` table: `kind (approval|question|alert)`,
  `context` (serialized JSON), `status (pending|resolved)`.
- `src/control-plane/steps.ts` lines 157–181 — `claimNextStep`: already filters on
  `run_after <= nowIso` (line 181), so a step with a future `run_after` is not claimed until
  its window opens — the polling re-queue works today without any loop change.
- `src/worker/runner-dispatch.ts` lines 6–17 — `createRunAgent` dispatches on `role.runner`; the
  `default` case throws `RUNNER_NOT_IMPLEMENTED` — adding `'script'` here is the only dispatch
  change.
- `src/control-plane/definitions.ts` lines 4–12 — `Role` type; `runner` is currently typed
  `'claude-code' | 'codex'`.
- `src/worker/loop.ts` lines 139–147 — `runNextStep` → `claimNextStep` → `processClaimedStep` →
  `handleResult`; the `script` runner must return a valid `AttemptResult` (same interface as
  `claude-code`).
- `src/worker/claude-code-runner.ts` — shape to mirror for the script runner factory.
- `docs/plans/0008-claude-code-runner.md` open findings, "Plan 0011 — GitHub PR/commit automation
  + idempotent external create keyed on `attemptId`."

Key facts:

1. `claimNextStep` already respects `run_after` (`steps.ts:181`): a poll step can re-queue
   itself by returning `nextSteps: [{ ..., runAfter: nowISO + 30s }]` — no loop change needed.
2. `steps.output` is a serialized-JSON string. The poller writes its gathered findings to
   the step output; the downstream LLM judge step reads them from `step.input` (the loop copies
   `nextSteps[i].input` into the child step's `input` field at `createSteps` time).
3. `inbox` already exists. `needsHuman: true` in the poller's `AttemptResult` parks the step to
   `awaiting_approval` via the existing `parkForHuman` path in `loop.ts:100–135`.
4. The `script` runner runs a deterministic Node/TS module — no LLM, no tokens. It must satisfy
   the same `RunAgent` interface as the `claude-code` runner (`src/worker/runner.ts`).
5. The LLM judge step (updated `pr-watcher` role) must receive the poller's structured output in
   its `input`; it reads CI verdict, Sonar issues, and threads as structured data — only
   human/bot free-text comments need LLM classification.

---

## 1. Extend the `Role` type and loader with `'script'` runner

**Files to change:**

- `src/control-plane/definitions.ts`

**Implementation notes:**

Change the `runner` union in the `Role` type (line 9):

```ts
runner: 'claude-code' | 'codex' | 'script';
```

In `loadRole` (line 57), the existing cast `as Role['runner']` will now accept `'script'` from the
seed row without any logic change. Verify the cast is safe by checking the `default` throw in the
dispatcher (Step 2) acts as the validation boundary.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- Do not add `script_ref` or any new field to `Role` in this step. The script to run is resolved by
  the runner dispatch in Step 2 based on the role name — not stored in `Role`. Adding a `script_ref`
  field to `Role` and the schema is a follow-up if more than one script-runner role is needed.

---

## 2. `ScriptRunner` factory and dispatch

**Files to create/change:**

- Create `src/worker/script-runner.ts`
- Create `src/worker/script-runner.test.ts`
- Change `src/worker/runner-dispatch.ts`

**Implementation notes:**

### `script-runner.ts`

A factory that closes over injected script modules and returns a `RunAgent`:

```ts
export type ScriptModule = {
  run(input: unknown, step: Step): Promise<AttemptResult>;
};

export type ScriptRunnerDeps = {
  scripts: Record<string, ScriptModule>;  // role name → script module
  timeoutMs?: number;                      // default 120_000 (2 min — polls are fast)
};

export function createScriptRunner(deps: ScriptRunnerDeps): RunAgent;
```

Behavior of the returned `runAgent({ role, context, attemptId, step })`:

1. Look up `deps.scripts[role.name]`. If not found, throw
   `Error('SCRIPT_NOT_FOUND: no script registered for role "${role.name}"')`.
2. Parse `step.input`: `typeof step.input === 'string' ? JSON.parse(step.input || '{}') : (step.input ?? {})`.
   The control-plane stores `input` as a serialized JSON string in the DB column, but `createSteps`
   writes the `nextSteps[i].input` object directly into the row — by the time `mapStep` reads it back
   the value is already a parsed object (see `steps.ts:mapStep` line 111: `input: d.input ?? null`).
   Never assume the type; guard both cases.
3. Call `module.run(parsedInput, step)` with an enforced timeout (`Promise.race` against a timer
   that rejects with a lesson-bearing error).
4. Return the `AttemptResult` the module produces directly — no envelope parsing needed (the script
   returns a typed object, not a text block).
5. On timeout or thrown error, let it propagate — the loop's catch → `failStep` handles it.

The script module interface is minimal: it receives the parsed step input and the full `Step` record
(for `step.id`, `step.runId`, `step.taskId`). It must return a valid `AttemptResult`.

### `runner-dispatch.ts`

Extend `createRunAgent` to accept and dispatch the `script` runner:

```ts
export function createRunAgent(deps: { claudeCode: RunAgent; script?: RunAgent }): RunAgent
```

Add to the `switch`:

```ts
case 'script':
  if (!deps.script) throw new Error('RUNNER_NOT_IMPLEMENTED: script runner not wired');
  return deps.script(args);
```

The script runner is optional in `deps` so existing wiring that passes only `{ claudeCode }` is
unchanged (the `'script'` case throws `RUNNER_NOT_IMPLEMENTED` unless explicitly wired — same
pattern as `codex`).

**Unit tests:**

- `createScriptRunner`: registered script is called with parsed input and step; unregistered role
  throws `SCRIPT_NOT_FOUND`; timeout rejects and the error message names the duration.
- `createRunAgent` dispatch: `'script'` with `deps.script` wired delegates correctly; `'script'`
  without `deps.script` throws `RUNNER_NOT_IMPLEMENTED`.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- Do not import `ProcessExecutor` or `claude-code-runner.ts` here. The script runner is completely
  separate from the process-spawning path.
- Do not change `src/worker/runner.ts` (`RunAgent` / `AttemptResult` types).
- The `ScriptRunner` does NOT call `normalizeNextSteps` (that helper is part of the `claude-code`
  runner's envelope-parsing path). Script modules must therefore include ALL required `NewStepSpec`
  fields explicitly — especially `modelProfile` — in every `nextSteps` entry they return.

---

## 3. PR readiness poller script

**Files to create:**

- `src/poller/pr-readiness.ts`
- `src/poller/pr-readiness.test.ts`

**Implementation notes:**

The script is a pure function (no side effects beyond reading `gh api` / Sonar). It satisfies
`ScriptModule`:

```ts
export async function run(input: PollInput, step: Step): Promise<AttemptResult>
```

`PollInput` (parsed from `step.input`):

```ts
type PollInput = {
  pr_number: number;
  repo: string;            // e.g. "owner/repo"
  sonar_project?: string;  // Sonar project key; omit to skip Sonar
  poll_count: number;      // 0 on first invocation; incremented each re-queue
  poll_interval_ms?: number; // override default 30 000 ms
  max_polls?: number;        // override default 20
};
```

Script logic (single pass — no internal polling loop):

0. Resolve effective configuration (in order of priority: `input` field → env var → default):
   ```ts
   const maxPolls = input.max_polls ?? Number(process.env['MAX_POLLS'] ?? 20);
   const pollIntervalMs = input.poll_interval_ms ?? Number(process.env['POLL_INTERVAL_MS'] ?? 30_000);
   ```
   Keep module-level constants as documentation of defaults:
   ```ts
   const DEFAULT_MAX_POLLS = 20;
   const DEFAULT_POLL_INTERVAL_MS = 30_000;
   ```
1. Call `gh api repos/<repo>/pulls/<pr_number>/commits` and
   `gh api repos/<repo>/statuses/<sha>` (or the Checks API: `gh api repos/<repo>/commits/<sha>/check-runs`)
   via Node `execFileSync('gh', [...])`. Collect all check statuses.
2. If ANY check status is `in_progress` or `queued` (not yet terminal):
   - If `poll_count >= maxPolls`: return
     `{ output: { verdict: 'timeout', ... }, nextSteps: [], needsHuman: true, costs: [] }` — triggers
     `parkForHuman`.
   - Else: return
     ```ts
     nextSteps: [{
       role: 'ci-poller', kind: 'poll',
       input: { ...input, poll_count: input.poll_count + 1 },
       runAfter: <ISO + pollIntervalMs>,
       taskId: step.taskId,
       modelProfile: step.modelProfile,   // REQUIRED — ScriptRunner has no normalizeNextSteps
     }]
     ```
     Loop re-queues after `pollIntervalMs`.
3. If all checks are terminal (success, failure, cancelled, skipped):
   - Collect CI verdict: any `failure`/`cancelled` → `ci_passed: false`; all `success`/`skipped` → `ci_passed: true`.
   - If `sonar_project` is set: call `gh api` against the Sonar API (or local `sonar:issues:local` script referenced in `package.json`) to collect all issues above the threshold. Treat Sonar API unavailability as a warning, not a blocker — include a `sonar_unavailable: true` flag.
   - Collect PR review threads: `gh api repos/<repo>/pulls/<pr_number>/reviews` and
     `gh api repos/<repo>/pulls/<pr_number>/comments`. Separate human comments from bot comments
     (bots have `type: 'Bot'` on the user object).
   - Return:
     ```ts
     nextSteps: [{
       role: 'pr-watcher', kind: 'judge',
       input: { ci_passed, ci_summary, sonar_issues, open_threads, human_comments, bot_comments },
       taskId: step.taskId,
       modelProfile: step.modelProfile,   // REQUIRED — ScriptRunner has no normalizeNextSteps
     }]
     ```
     — the LLM judge step.
4. Return `costs: []` (no LLM; zero cost).

**Unit tests** (no real `gh` CLI needed — inject an `execGh` function):

- All checks `in_progress` + `poll_count < maxPolls` (use default 20) → re-queue with incremented
  `poll_count`, future `runAfter`, and the correct `modelProfile` from `step.modelProfile`.
- `poll_count === maxPolls` → `needsHuman: true`, empty `nextSteps`.
- All checks terminal + CI passed → judge step in `nextSteps` with `ci_passed: true`.
- All checks terminal + CI failed → judge step with `ci_passed: false`.
- `sonar_project` absent → `sonar_issues` is empty array, no Sonar call made.
- Sonar API unavailable → `sonar_unavailable: true` flag; judge step still emitted.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- Do not call `claude -p` or any LLM API from this script. All logic must be deterministic: parse
  structured API responses, apply simple boolean/string rules.
- Do not hard-code a GitHub token; rely on `gh` CLI authentication (the same auth used by the
  integrator role).
- If `gh api` returns an unexpected schema (e.g. check-runs vs statuses endpoint shape), **stop and
  report** — the exact API shape must be verified before coding the parser.

---

## 4. Seed `ci-poller` role + update `pr-watcher` role

**Files to change:**

- `control-plane/bootstrap.config.json`

**Implementation notes:**

Add a new role row for `ci-poller`:

```json
{
  "tableId": "roles",
  "rowId": "ci-poller",
  "data": {
    "id": "ci-poller",
    "name": "ci-poller",
    "system_prompt": "",
    "model_level": "cheap",
    "effort": "low",
    "runner": "script",
    "allowed_tools": [],
    "scope_rules": "{}",
    "updated_at": "2026-06-04T00:00:00.000Z"
  }
}
```

`runner: "script"` — the `ScriptRunner` dispatches to `src/poller/pr-readiness.ts` by role name
(see Step 2). `system_prompt` is empty: the script runner does not build a prompt.
`allowed_tools` is empty: the script runner does not use `allowed_tools` (it is a Node function,
not a claude session).

Also update the schema documentation for the `runner` field — wherever the valid runner values are
described (e.g. `docs/control-plane-schema.md` and any inline JSON Schema `description` on the `roles`
table's `runner` column), update the union to `claude-code|codex|script`.

Update the existing `integrator` role (currently line 628 of `bootstrap.config.json`) to spawn
`ci-poller` as the chain entry instead of `pr-watcher` directly. Change the final sentence of its
`system_prompt` from:

```text
…set nextSteps to one pr-watcher step (role 'pr-watcher', kind 'watch').
```

to:

```text
…set nextSteps to one ci-poller step (role 'ci-poller', kind 'poll', input: { pr_number: <N>, repo: '<owner/repo>', sonar_project: '<key-or-omit>', poll_count: 0 }).
```

(The ci-poller is now the chain entry; it gathers CI data and hands structured findings to
`pr-watcher` — the integrator never spawns `pr-watcher` directly.)

Update the existing `pr-watcher` role (currently lines 639–651 of `bootstrap.config.json`) to
reflect its new responsibility — it now receives structured data and judges only free-text comments.
Change its `system_prompt` to:

```
You are the PR-Judge agent in an autonomous dev loop. You receive pre-gathered, structured findings:
CI verdict (ci_passed), Sonar issues list, and human/bot review comments (open_threads,
human_comments, bot_comments). Do NOT re-run gh api or re-check CI — the data is already collected.
Your job is to classify only the free-text human and bot comments: decide which (if any) are
blocking findings that require developer action. Apply the stopping criterion: if ci_passed is true
AND sonar_issues is empty AND no human comment is a blocking request-for-change, the PR is READY.
In your result: set output to the merge verdict (READY or NEEDS_WORK). If NEEDS_WORK, set nextSteps
to one developer step carrying only the blocking findings. If READY, set nextSteps [].
```

Keep `model_level: "cheap"` and `runner: "claude-code"` for `pr-watcher` — it is still an LLM step,
just a narrower one.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
node --input-type=module -e "
import('./dist/control-plane/index.js').then(async m => {
  const r = await m.loadRole('ci-poller');
  console.log(r.runner, r.name);   // should print: script ci-poller
  const pw = await m.loadRole('pr-watcher');
  console.log(pw.runner);          // should print: claude-code
})"
```

**Stop conditions:**

- Do not commit runtime rows (task_runs, steps, inbox) via `bootstrap --commit` — only the versioned
  `roles` row is committed here, consistent with the versioning boundary in
  `docs/control-plane-schema.md`.

---

## 5. Wire the script runner into `revo work`

**Files to change:**

- `src/cli/commands/work.ts`

**Implementation notes:**

Import `createScriptRunner` and the poller script module:

```ts
import { createScriptRunner } from '../../worker/script-runner.js';
import * as prReadiness from '../../poller/pr-readiness.js';
```

Extend the `runnerMode === 'auto'` branch to also wire the script runner:

```ts
const scriptRunner = createScriptRunner({
  scripts: { 'ci-poller': prReadiness },
});

const runAgent: RunAgent = createRunAgent({
  claudeCode: createClaudeCodeRunner({ ... }),
  script: scriptRunner,
});
```

When `runnerMode === 'stub'`, the `script` dep is omitted from `createRunAgent` — a `ci-poller`
step in stub mode will route to the `'script'` case, find no runner wired, and throw
`RUNNER_NOT_IMPLEMENTED` (routing to `failStep` with a clear lesson — not a silent failure).

No change to `runWorker`, `WorkerDeps`, or the loop.

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- work --help
```

> **Note on `--roles`:** the worker must include `ci-poller` in its roles list to claim polling
> steps. The default `revo work` roles are `architect,developer` — extend to
> `architect,developer,reviewer,integrator,pr-watcher,ci-poller` when running the full pipeline:
> ```bash
> ./bin/revo.js work --runner auto --roles architect,developer,reviewer,integrator,pr-watcher,ci-poller
> ```

**Stop conditions:**

- Do not import the poller module unconditionally at the top of `work.ts` if it transitively imports
  `node:child_process` in a way that breaks `--help` without a running daemon. Guard with a lazy
  import if needed; verify `--help` works without the daemon.

---

## 6. Live smoke (manual — requires `gh` auth and a real PR)

**Files to create:**

- `scripts/smoke-pr-poller.ts`
- Add `"smoke:pr-poller": "tsx scripts/smoke-pr-poller.ts"` to `package.json`

**Implementation notes:**

This smoke is **not** added to `npm test` or `npm run verify` — it requires `gh` auth and a real
open PR (create a throwaway draft PR if needed).

1. Instantiate the poller script directly:
   ```ts
   import * as prReadiness from '../src/poller/pr-readiness.js';
   ```
2. Call `prReadiness.run({ pr_number: <N>, repo: '<owner/repo>', poll_count: 0 }, fakeStep)` where
   `fakeStep` has a valid `step.id` and `step.taskId`.
3. Assert: result is one of `{ nextSteps: [{ role: 'ci-poller' }] }` (pending) or
   `{ nextSteps: [{ role: 'pr-watcher' }] }` (terminal). Print the full result for inspection.
4. If terminal, assert that `ci_passed`, `sonar_issues`, and `open_threads` are present in the judge
   step's `input`.
5. Print the real `gh api` response shape (check-runs) so Step 3's parser can be confirmed.

**Verify (manual):**

```bash
npm run smoke:pr-poller
```

**Stop conditions:**

- If `gh api` returns a different check-run schema than what Step 3 implements, **stop and report** —
  update Step 3's parser against the observed shape before trusting the poller in production.

---

## 7. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
npm run typecheck
npm run lint:ci
npm test
npm run revo -- work --help
npm run build
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
node --input-type=module -e "
import('./dist/control-plane/index.js').then(async m => {
  const r = await m.loadRole('ci-poller');
  console.assert(r.runner === 'script', 'ci-poller must have runner:script');
  console.log('OK');
})"
git diff --check
./bin/revo.js revisium stop
```

Run the full pipeline with the extended roles list:

```bash
./bin/revo.js work --runner auto --roles architect,developer,reviewer,integrator,pr-watcher,ci-poller
```

**Slice is done when:** `ci-poller` role is seeded with `runner: "script"`, `ScriptRunner` dispatches
to `src/poller/pr-readiness.ts`, the poller re-queues via `run_after` when CI is pending and emits
a judge step when terminal, `needsHuman: true` is returned when `max_polls` is reached, `pr-watcher`
receives structured findings and judges only free-text, all unit tests pass at zero LLM cost, the
loop and `WorkerDeps` are unchanged, the `integrator` role spawns `ci-poller` (not `pr-watcher`)
directly, and the manual smoke has confirmed the real `gh api` shape.

---

## 8. Report back / open findings

Report:

1. `ScriptRunner` interface (`ScriptModule`, `scripts` registry) and how dispatch adds `'script'` to
   `createRunAgent` without changing the loop.
2. Poller logic: the single-pass design, effective `maxPolls` / `pollIntervalMs` resolution order
   (input field → env var → default), re-queue via `runAfter`, human-fallback path.
3. The deterministic/LLM split: what the poller classifies structurally (CI status, Sonar issues,
   open review threads) vs what `pr-watcher` classifies with LLM (free-text human/bot comments only).
4. How the poller's result enters the loop: `nextSteps[0].input` carries the structured findings into
   the judge step's `step.input` (confirm via `createSteps` in `src/control-plane/steps.ts`).
5. `ci-poller` seed row committed; `pr-watcher` system_prompt updated; no runtime rows committed.
6. Validation: typecheck, lint, test, smoke output, and confirmation of zero LLM cost for the poller.
7. The real `gh api` check-run response shape observed in the manual smoke.

Open findings / deferred:

- **Sonar API integration** — the poller stub-skips Sonar when `sonar_project` is absent; a follow-up
  configures the Sonar host/token per project.
- **CodeRabbit / review-bot recognition** — the poller separates bots by `user.type === 'Bot'`; a
  curated allow-list for known review bots (CodeRabbit, SonarCloud) is a follow-up.
- **`run_after` precision** — `claimNextStep` compares ISO strings lexicographically
  (`steps.ts:181`); verify this is reliable for short poll intervals (30 s) in the smoke.
- **Inbox resolution** — `parkForHuman` currently sets `awaiting_approval` but does not create an
  `inbox` row (deferred to Plan 0009); the human fallback path here reuses the same partial
  implementation.
- **Idempotent external creates** — Plan 0008 open findings; the poller itself performs no write
  actions so `attemptId` keying is not yet needed here.

Needs human / ADR sign-off:

- **p95 CI duration for this repo?** — the defaults (30 s interval × 20 polls = 10 min cap) were
  chosen conservatively; adjust `poll_interval_ms` / `max_polls` in the ci-poller seed row or via
  env once real CI timing is measured. Confirm before enabling in production.
- **`pr-watcher` rename to `pr-judge`** — explicitly out of scope for this plan (see Out of scope
  section above). Tracked as a separate ADR to avoid a breaking change for in-flight steps.
