# Plan 0008 - Claude Code headless runner (real `runAgent`)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** the real `runAgent` for `role.runner === 'claude-code'` — a headless `claude -p`
> invocation built behind one function, executed through an **injectable process-executor** so it is
> unit-testable without spawning a process or spending tokens. It parses a defined result envelope into
> `AttemptResult`, enforces a timeout, threads the pre-minted `attemptId` for idempotency, maps failures to a
> `lesson`, honours `needsHuman`, and is wired behind `revo work` (flag-gated, loop unchanged).
> **Out of scope (deferred to named later plans):**
> - **Codex runner** — the second branch of the same function. Left as a clearly-marked not-implemented branch
>   here; its own slice later.
> - **Multi-repo / clone / container isolation hardening** — Plan 0010 (multi-repo strategies). This slice runs
>   in a single resolved working directory.
> - **GitHub PR/commit automation + idempotent external create** — Plan 0011. This slice performs **no** external
>   create; it only threads the idempotency key so 0011 can key on it.
> - **Inbox row creation + approval resolution** — Plan 0009. `needsHuman` here reuses the existing
>   `awaiting_approval` parking the loop already does.
> - **Routing-policy evaluation, multi-worker lease reaping.**

---

## Design decisions (made for the implementor — do not relitigate without sign-off)

1. **Injectable executor is the testability seam.** All process spawning hides behind a `ProcessExecutor`
   function injected into the runner factory. Unit tests pass a fake executor returning canned stdout/exit code;
   no real `claude`, no LLM, no token cost. This is the single most important decision in this plan (Step 1).
2. **Two-layer result envelope.** `claude -p --output-format json` gives a *transport* envelope (final text +
   cost/usage); the agent emits its *own* structured payload as a sentineled `REVO_RESULT` block inside that
   final text. The runner parses the transport envelope, extracts the agent block, and builds `AttemptResult`
   (Step 2). Defined exactly below.
3. **Working directory is injected, not discovered by the runner.** Invariant 4 (schema sealed in the repo
   layer): the runner must not read control-plane tables. The factory receives `resolveCwd(step) => Promise<string>`;
   the default resolver lives in the `revo work` wiring (reads the task `repo_ref` via the data-access layer).
   MVP resolves a single directory; per-repo clone/container isolation is Plan 0010.
4. **`--runner` defaults to `stub`.** Real `claude -p` costs tokens and must be hand-verified first
   (runner-contract "Verify by hand before coding"). The flag opts into the live dispatcher; the default keeps
   `npm test` and `smoke:worker-loop` zero-cost. Flipping the default is a trivial follow-up once the manual
   smoke (Step 6) passes — and is gated by a stop condition.
5. **Failure → throw → existing `failStep`.** The loop already wraps `runAgent` in try/catch and calls
   `failStep` (which backs the step off to `ready`, or `dead` at the attempt cap). The runner therefore signals
   timeouts and unrecoverable errors by **throwing an `Error` whose message is the lesson** — no loop change.
6. **The runner — not the role or the context builder — tells the agent how to emit `REVO_RESULT`.** The
   emission instruction lives next to the parser that consumes it: the runner **appends a fixed `REVO_RESULT`
   contract string to every prompt** (Step 3). This keeps the protocol inside the runner (runner-hides-protocol),
   guarantees no drift between what the agent is told and what the parser expects, and means **every attempt —
   including retries — is always instructed**. It is deliberately **not** seeded into each role `system_prompt`
   (would drift per-role and across runners) and **not** placed in shared `build-context.ts` (the stub runner
   uses that too and needs no envelope). The single source of truth is one exported constant
   (`REVO_RESULT_CONTRACT`, Step 2) that the runner appends and the parser's markers consume.

---

## 0. Context you must read first

- `docs/runner-contract.md` - the `runAgent` / `AttemptResult` contract: dispatch by `role.runner`, isolation,
  `attemptId` minted before the run, timeout, `needsHuman`, `lesson`, and the **hard rules** (no undocumented CLI
  flags; capability negotiation stays inside the runner; hand-verify the round-trip).
- `docs/architecture-overview.md` - the **five invariants**. This slice must not break: (2) the loop stays dumb,
  (3) agents are short-lived, (4) only the data-access layer knows the schema.
- `docs/repo-layer-contract.md` - where `loadRole`/`loadModelProfile`/`buildContext` and lifecycle verbs sit.
- `docs/context-budget.md` - what the `context` string passed to the runner may contain.
- `docs/control-plane-schema.md` - the versioned vs runtime boundary (no runtime commits).
- `docs/plans/0007-dumb-worker-loop.md` - the slice this builds on; mirror its structure and voice.
- `src/worker/runner.ts` - the `RunAgent` and `AttemptResult` types this runner must satisfy (do not change them).
- `src/worker/stub-runner.ts` - the zero-cost stub this runner is swapped in for (its shape is the model to match).
- `src/worker/loop.ts` - how `runAgent` is injected (`WorkerDeps.runAgent`) and called (`processClaimedStep`):
  `startAttempt` mints `attemptId` **before** the call; a thrown error routes to `failStep`; `needsHuman` parks.
- `src/control-plane/steps.ts` - `startAttempt` (mints `attemptId`/`idempotency_key`), `failStep` (backoff→ready
  / cap→dead), `Step`, `NewStep`, `CostRecord`.
- `src/control-plane/definitions.ts` - `Role` (`runner`, `allowedTools`, `modelLevel`) and `ModelProfile`
  (`modelId`, `provider`, `costPerInput`, `costPerOutput`).
- `src/worker/build-context.ts` - the `context` the runner receives (role prompt, task title/scope/repo, prior
  lessons, current input).
- `src/cli/commands/work.ts` - the wiring point; today hardcodes `runAgent: stubRunAgent`.
- `control-plane/bootstrap.config.json` - seed `roles` (`architect`/`developer`, both `runner: claude-code`,
  `allowed_tools: []`) and `model_profiles` (`standard` → `claude-sonnet-4-6`, etc.).
- `scripts/smoke-worker-loop.ts` - the existing zero-cost smoke; the manual real-claude smoke mirrors its CLI
  harness (`runCli`, `createControlPlaneDataAccess`).

Key facts:

1. `attemptId` is **already minted before the runner runs** (`startAttempt` in `loop.ts`). The runner consumes it;
   it never mints its own.
2. The loop is dumb. The runner — not the loop — produces `nextSteps`. Dispatch by `role.runner` lives in the
   runner layer.
3. The runner must not read control-plane tables (invariant 4). The working directory is injected.
4. CLI flags drift. The exact `claude -p` flag set that yields a non-interactive JSON round-trip (clean exit, no
   hang — there is no TTY to prompt in `-p` mode) is **verified by hand** (Step 6) before the runner code is
   trusted; capability negotiation stays inside the runner module.
5. Roles seed `allowed_tools: []` today. The architect's first real round-trip emits a plan as text and needs no
   tools, so `[]` is fine for the manual smoke. Granting a role tools (e.g. developer Edit/Write/Bash) is a
   **data edit** to the seed row — no runner/loop change.

---

## 1. Injectable process-executor boundary

**Files to create/change:**

- Create `src/worker/process-executor.ts`
- Create `src/worker/process-executor.test.ts`

**Implementation notes:**

Define the seam that lets the runner be tested without spawning a real process:

```ts
export type ExecRequest = {
  command: string;          // 'claude'
  args: string[];           // ['-p', '--model', 'claude-sonnet-4-6', '--output-format', 'json', ...]
  cwd: string;              // resolved target repo directory
  timeoutMs: number;        // kill after this
  input?: string;           // prompt piped on stdin (avoids argv length limits for large context)
  env?: Record<string, string>;
};

export type ExecResult = {
  code: number | null;      // process exit code; null if killed
  stdout: string;
  stderr: string;
  timedOut: boolean;        // true if killed by the timeout
};

export type ProcessExecutor = (req: ExecRequest) => Promise<ExecResult>;

// Real implementation, used only in production wiring (never in unit tests).
export const spawnExecutor: ProcessExecutor = async (req) => { /* node:child_process spawn */ };
```

`spawnExecutor` notes:

- Use `node:child_process` `spawn(req.command, req.args, { cwd, env, detached: true })`; write `req.input` to
  `stdin` and `end()`. **`detached: true` is required** so the child becomes its own process-group leader — only
  then does a negative-PID signal reap `claude` *and the subprocesses it spawns*. Without it, on darwin/Linux a
  `process.kill(-pid)` either throws `ESRCH` or kills nothing, and `claude`'s children outlive the timeout.
  (Do **not** `child.unref()` — the parent must stay attached to collect stdout/stderr and observe exit.)
- Collect `stdout`/`stderr` as utf8.
- Enforce `timeoutMs` with a timer that, on expiry, kills the whole group: `process.kill(-child.pid, 'SIGKILL')`
  (fall back to `child.kill('SIGKILL')` if the group send throws); set `timedOut = true` and resolve (do not
  reject) so the runner decides how to map it.
- Never throw for a non-zero exit; return `{ code, stdout, stderr, timedOut }`. Spawn-level errors
  (binary missing) reject — the runner converts that to a lesson.

**Verify:**

```bash
npm run typecheck
npm test
```

Unit tests (no real `claude`): run a trivial cross-platform command through `spawnExecutor` (e.g.
`node -e "process.stdout.write('hi')"`) to assert stdout capture and exit code; run a sleeping command with a
tiny `timeoutMs` to assert `timedOut === true` and the child is killed. Keep these fast and deterministic.

**Stop conditions:**

- Do not invoke `claude` here. This module knows nothing about Claude Code — it is a generic spawn boundary.

---

## 2. Result-envelope contract + parser

**Files to create/change:**

- Create `src/worker/result-envelope.ts`
- Create `src/worker/result-envelope.test.ts`

**Implementation notes:**

This is the **exact contract** between the agent and the runner. Two layers.

**Layer A — transport envelope** (`claude -p --output-format json` stdout). Parse defensively; field names are
read inside this module only, so a CLI drift is a one-file change. Read:

- the final assistant text (the field carrying the agent's last message / `result`),
- `is_error` (treat truthy as failure),
- cost: a reported total USD if present, else token usage (`input_tokens` / `output_tokens`).

If stdout is not valid JSON, throw `Error('claude -p did not return parseable JSON (transport envelope)')`.

**Layer B — agent result envelope** (what the agent MUST emit inside its final text). A single sentineled JSON
block; the runner extracts the substring between the markers and `JSON.parse`s it.

Export the instruction text verbatim as a **single constant — `REVO_RESULT_CONTRACT`** — from this module. It is
the **one source of truth**: Step 3's runner appends it to every prompt (so the agent is always told how to
emit), and this module's parser keys on the same `<<<REVO_RESULT` / `REVO_RESULT>>>` markers. Define it exactly:

```ts
export const REVO_RESULT_CONTRACT = `
You MUST end your reply with a single result block in EXACTLY this form — the markers on their own lines,
valid JSON between them, and NOTHING after the closing marker:

<<<REVO_RESULT
{
  "output": <any JSON — a short human-readable summary or structured result>,
  "artifacts": <any JSON, optional — e.g. { "planPath": "docs/plans/00xx.md" }; omit if none>,
  "nextSteps": [
    { "role": "developer", "kind": "implement", "input": { "from": "<this step>" },
      "modelProfile"?: "standard", "taskId"?: "<defaults to the current step's task>",
      "priority"?: 0, "maxAttempts"?: 3, "dependsOn"?: [], "runAfter"?: "" }
  ],
  "needsHuman": false,
  "lesson": null
}
REVO_RESULT>>>

If you have no follow-up work, return "nextSteps": []. If you are blocked and need a human, set
"needsHuman": true and "nextSteps": []. Emit the block exactly once.
`;
```

The parser extracts the substring between the markers and `JSON.parse`s it.

Normalization rules the parser enforces:

- Each `nextSteps[i]` maps to `NewStepSpec` (`= Omit<NewStep, 'runId'>`). Require `role`, `kind`, `input`.
  Default `taskId ← step.taskId` and `modelProfile ← step.modelProfile` when the agent omits them (the agent
  must not need to know IDs). Pass through optional `priority`/`maxAttempts`/`dependsOn`/`runAfter`.
- `needsHuman` coerces to boolean (default `false`). `lesson` to string-or-undefined.
- If the `REVO_RESULT` block is **absent or unparseable**, throw
  `Error('agent did not emit a parseable REVO_RESULT envelope')`. This becomes the prior-attempt lesson, but it
  is **not** what fixes the next attempt: the corrective is the `REVO_RESULT_CONTRACT` the runner **re-appends to
  every prompt, including retries** (Step 3 / design decision 6). The lesson string only signals *that* the last
  attempt malformed its output; the always-appended contract is what re-states *how* to emit. (Do not assume
  `build-context.ts` re-instructs the agent — it only surfaces the format-less lesson string.)
- If a `nextSteps` entry is malformed (missing `role`/`kind`/`input`), throw a lesson-bearing error naming the
  offending index.

Export pure functions so they are trivially unit-tested:

```ts
export function parseTransportEnvelope(stdout: string): { text: string; isError: boolean; costUsd?: number; inputTokens?: number; outputTokens?: number };
export function extractAgentResult(text: string): { output: unknown; artifacts?: unknown; nextSteps: unknown[]; needsHuman: boolean; lesson?: string };
export function normalizeNextSteps(raw: unknown[], step: Step): NewStepSpec[];
```

**Verify:**

```bash
npm run typecheck
npm test
```

Unit cases (fixtures only, no process): valid transport+agent envelope → fields extracted; missing
`REVO_RESULT` → throws the documented lesson; `nextSteps` defaulting of `taskId`/`modelProfile`; `is_error`
true detected; non-JSON stdout → throws; **marker-sync guard** — a fixture whose body is `REVO_RESULT_CONTRACT`
with its placeholders replaced by valid JSON parses cleanly (proves the parser's markers stay in sync with the
constant the runner appends).

**Stop conditions:**

- Do not change `AttemptResult` / `NewStepSpec` / `RunAgent` in `runner.ts`. The envelope maps **into** them.
- If the real `claude -p --output-format json` shape (captured in Step 6) differs from what
  `parseTransportEnvelope` assumes, fix this module — but **stop and report** if it forces an `AttemptResult`
  shape change (that is contract-level, ADR-worthy).

---

## 3. Claude Code runner factory

**Files to create/change:**

- Create `src/worker/claude-code-runner.ts`
- Create `src/worker/claude-code-runner.test.ts`

**Implementation notes:**

A factory that closes over its dependencies and returns a `RunAgent`:

```ts
export type ClaudeCodeRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>;   // injected; default reads task repo_ref (wired in Step 5)
  timeoutMs?: number;                              // default e.g. 600_000 (10 min)
  command?: string;                                // default 'claude'
};

export function createClaudeCodeRunner(deps: ClaudeCodeRunnerDeps): RunAgent;
```

Behavior of the returned `runAgent({ role, profile, context, attemptId, step })`:

1. **Build the invocation** (the only place CLI specifics live):
   - base: `claude -p --model <profile.modelId> --output-format json`
   - tools: map `role.allowedTools` → the documented allowed-tools flag. **Empty list → pass no tools**
     (most restrictive; text/plan-only). Never widen beyond `role.allowedTools`.
   - a non-interactive permission flag (e.g. `--permission-mode`) so a tool that would need approval does not
     stall the run. In `-p` (headless) mode there is **no TTY**, so an un-permitted tool does not open a dialog —
     it errors or hangs; the permission flag plus the Step-3 timeout are what keep the run non-interactive (exact
     flag confirmed in Step 6).
   - prompt: pass the full prompt on **stdin** (`ExecRequest.input`) to avoid argv length limits; keep the `-p`
     form per the contract. The prompt is assembled, in order, as: **`context`** (from `buildContext`) → the
     **`attemptId`** line (idempotency key, below) → **`REVO_RESULT_CONTRACT`** (Step 2). Appending the contract
     here — not in `build-context.ts`, not in the role `system_prompt` — is what guarantees the agent is told how
     to emit on **every** attempt, including retries (design decision 6).
   - prepend/append the **idempotency key** (`attemptId`) into the prompt so any external effect the agent makes
     can be keyed (see idempotency below).
   - `cwd = await resolveCwd(step)`; `timeoutMs = deps.timeoutMs ?? 600_000`.
2. **Execute** via `deps.executor(req)` — the ONLY way a process is launched.
3. **Timeout:** if `result.timedOut`, throw `Error('claude-code runner exceeded <N>ms')`. The loop's catch →
   `failStep` returns the step to `ready` (backoff) or `dead` at the cap — satisfying the contract's
   "return the step to ready/inbox" with no loop change.
4. **Process failure:** if `code !== 0` → throw `Error` with a concise tail of `stderr`/stdout as the lesson.
5. **Parse** with Step 2: `parseTransportEnvelope` → if `isError`, throw with the text as lesson;
   `extractAgentResult` → `normalizeNextSteps`.
6. **`needsHuman`:** if the agent envelope sets it, return `{ output, needsHuman: true, nextSteps: [], costs,
   lesson }`. The contract says a `needsHuman` result does **not** write `nextSteps` — drop them.
7. **Costs:** build one `CostRecord` from the transport envelope: `{ modelProfile: step.modelProfile,
   inputTokens, outputTokens, costAmount, currency: 'USD' }`. Prefer the CLI-reported USD; else compute
   `inputTokens/1e6*profile.costPerInput + outputTokens/1e6*profile.costPerOutput`. Zero tokens → empty `costs`.
8. **Success:** return `{ output, artifacts, nextSteps, costs, needsHuman: false, lesson }`.

**Idempotency (this slice does no external create):** `attemptId` is already minted before the run (loop). The
runner threads it into the prompt so artifacts/effects can reference it, but the runner itself performs **no**
commit/PR — that automation, and its "create-only-if-key-unused" guard, is Plan 0011. Document the seam.

**Verify:**

```bash
npm run typecheck
npm test
```

Unit tests inject a **fake `ProcessExecutor`** (and a fake `resolveCwd` returning a temp path) — no real `claude`,
deterministic:

- **command build:** capture `ExecRequest`; assert `args` contain `-p`, `--model claude-sonnet-4-6`,
  `--output-format json`, the allowed-tools flag derived from `role.allowedTools` (and **absent** when `[]`), and
  `cwd` from `resolveCwd`; assert `context` is delivered on `input` and includes `attemptId`.
- **prompt contains the contract (regression guard):** capture `ExecRequest.input` and assert it contains
  `REVO_RESULT_CONTRACT` (both sentinel markers). This fails loudly if the runner ever stops appending the
  contract — i.e. it prevents auto-mode silently regressing to "the agent was never told how to emit."
- **envelope parse:** fake stdout with a `REVO_RESULT` block → `AttemptResult` with expected
  `output`/`artifacts`/`nextSteps`/`costs`.
- **timeout:** fake `{ timedOut: true }` → runner throws (message mentions the timeout).
- **error→lesson:** fake `{ code: 1, stderr: '...' }` and `is_error: true` cases → runner throws with a
  lesson-bearing message.
- **needsHuman:** envelope `needsHuman: true` → result `needsHuman` true and `nextSteps` empty.
- **idempotency:** assert `attemptId` appears in the delivered prompt; assert the runner makes no external call
  beyond `executor`.

**Stop conditions:**

- The runner must not import the data-access layer or read control-plane tables (invariant 4) — `resolveCwd` is
  injected.
- Do not hardcode an undocumented CLI flag. If a needed capability has no documented flag, **stop and report** —
  it is a runner-contract question, not an implementor decision.

---

## 4. Dispatch by `role.runner` (the one function the loop sees)

**Files to create/change:**

- Create `src/worker/runner-dispatch.ts`
- Create `src/worker/runner-dispatch.test.ts`

**Implementation notes:**

Hide all runner choice behind one `RunAgent`, dispatching on `role.runner`:

```ts
export function createRunAgent(deps: { claudeCode: RunAgent }): RunAgent {
  return async (args) => {
    switch (args.role.runner) {
      case 'claude-code': return deps.claudeCode(args);
      case 'codex':       throw new Error('RUNNER_NOT_IMPLEMENTED: codex runner is a later plan');
      default:            throw new Error(`RUNNER_NOT_IMPLEMENTED: unknown runner "${args.role.runner}"`);
    }
  };
}
```

The codex throw routes through `failStep` to a clear lesson — never silently no-ops. This is the MVP dispatch:
`claude-code` only; codex is a documented later branch.

**Verify:**

```bash
npm run typecheck
npm test
```

Unit cases: `claude-code` delegates to the injected runner (assert via a spy); `codex` and unknown throw
`RUNNER_NOT_IMPLEMENTED`.

**Stop conditions:**

- The loop must not learn about runner kinds. Dispatch lives here, behind the single `RunAgent` the loop injects.

---

## 5. Wire the real runner behind `revo work` (loop unchanged)

**Files to create/change:**

- Change `src/cli/commands/work.ts`

**Implementation notes:**

Add a `--runner <mode>` option, default `stub`:

- `stub` (default): inject `stubRunAgent` (today's behavior) — zero cost; keeps `npm test`/`smoke:worker-loop`
  green and free.
- `auto`: inject `createRunAgent({ claudeCode: createClaudeCodeRunner({ executor: spawnExecutor, resolveCwd,
  timeoutMs }) })` — dispatch by `role.runner`.

Add `--runner-timeout-ms <n>` (default 600000) wired into the factory.

`resolveCwd` default (wiring only — keeps schema knowledge out of the runner): read the step's task via the
data-access layer (`da.getRow('tasks', step.taskId)`), take `repo_ref`, resolve it against a workspace base
(repo `repoRoot` / `process.cwd()`). Fallback rules (do **not** silently yield an empty path — `getRow` returns
`null` for a missing row, and `buildContext` already tolerates that, so `resolveCwd` must guard explicitly):

- `repo_ref === '.'`, empty, or absent → the workspace base.
- a non-empty `repo_ref` → resolved against the base.
- **task row missing** (`getRow` → `null`) → **throw a lesson-bearing `Error`** (e.g.
  `` `resolveCwd: task ${step.taskId} not found — cannot resolve a working directory` ``) so the loop's catch →
  `failStep` records it, rather than running `claude` in an unintended directory.

Per-repo clone/container isolation is Plan 0010 — for MVP a single resolved directory is correct. *(Optional,
low-priority: a `resolveRepoRef(step)` verb in the repo layer would seal the `tasks`/`repo_ref` table knowledge
fully, like the other lifecycle verbs; the inline `da.getRow('tasks', …)` here matches the existing
`build-context.ts` precedent and is acceptable for this slice.)*

The injected `runAgent` is the only thing that changes; `runWorker` and `WorkerDeps` are untouched (invariant 2).
Update the command `description`/help to mention the modes.

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- work --help
```

`--help` must list `--runner` and `--runner-timeout-ms` and work without the daemon running.

**Stop conditions:**

- Do **not** change the default to `auto` in this slice. Flipping the default is gated on the Step 6 manual smoke
  passing and a cost review (stop condition below). The flag is the swap mechanism the contract asks for.
- Do not modify `src/worker/loop.ts` — if wiring seems to require a loop change, **stop and report**.

---

## 6. Manual real-`claude -p` smoke (NOT wired into `npm test`)

**Files to create/change:**

- Create `scripts/smoke-claude-runner.ts`
- Add `"smoke:claude-runner": "tsx scripts/smoke-claude-runner.ts"` to `package.json`

**Implementation notes:**

This is the **hand-verification the runner-contract requires** before the runner is trusted, and it is the only
place a real `claude -p` runs. It is **not** added to `npm test`, `npm run verify`, or any other smoke aggregate —
it spends tokens and needs auth.

Document at the top of the script (comment) and in the report-back:

- **Auth:** requires a logged-in / API-keyed `claude` CLI on PATH (the operator's machine).
- **Cost:** one real `standard`-profile call (one trivial round-trip). Non-zero, small.

Script flow (mirror `scripts/smoke-worker-loop.ts`'s `runCli` + `createControlPlaneDataAccess` harness):

1. Build the real runner: `createClaudeCodeRunner({ executor: spawnExecutor, resolveCwd: async () => <a
   throwaway temp dir>, timeoutMs: 120000 })`.
2. Call it once with a trivial architect-style `context` (a one-line task, `allowed_tools: []` — text-only, no
   tools). **Do not hand-write the `REVO_RESULT` instruction into the context** — the runner appends
   `REVO_RESULT_CONTRACT` itself (Step 3), so this smoke exercises the **same prompt path as auto-mode** and
   genuinely proves the agent emits the block when told only by the runner. (This is the point of the fix: the
   smoke must not paper over the emission instruction.)
3. Assert: the process completed **non-interactively** (clean exit, no hang — there is no TTY in `-p` mode, so a
   permission-needing tool would error/hang rather than prompt; assert the run finished within the timeout and
   exited 0), the transport envelope parsed, and the `REVO_RESULT` envelope produced a valid `AttemptResult`
   (capture and print the real transport-envelope JSON shape so Step 2's `parseTransportEnvelope` can be
   confirmed/corrected against reality).
4. Print the observed cost and exit 0 on success.

**Verify (manual — run only when validating, not in CI):**

```bash
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:claude-runner
```

**Stop conditions:**

- If `claude -p` hangs until the timeout or exits non-zero because a tool needed permission (no dialog can appear
  in headless `-p` mode — it blocks or errors instead), **stop**: the flag set is wrong. Fix the invocation
  (Step 3) and re-verify by hand. The contract makes this round-trip the foundation — do not proceed to trusting
  the runner or flipping the `--runner` default until it passes cleanly.
- If the real transport envelope differs from Step 2's assumptions, update `result-envelope.ts` and re-run its
  unit tests — but if it forces an `AttemptResult` change, **stop and report** (ADR-worthy).

---

## 7. Final acceptance test

The automated gate is **mock-based and zero-cost**. The real-`claude` smoke (Step 6) is a **separate, documented
manual step**, never part of this gate.

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
npm run typecheck
npm run lint:ci
npm test
npm run revo -- work --help        # lists --runner / --runner-timeout-ms
# (optional, exercises the existing zero-cost loop end-to-end — still stub by default)
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:worker-loop
git diff --check
./bin/revo.js revisium stop
```

(`npm run verify` = typecheck + lint:ci + test:cov covers the first three in one command.)

**Slice is done when:** the `claude-code` runner builds a `claude -p` invocation behind one function, runs it
through the **injected** executor, parses the two-layer envelope into `AttemptResult`, enforces a timeout,
threads `attemptId`, maps failures/timeouts to a `lesson` via the existing `failStep` path, honours `needsHuman`,
and is selectable behind `revo work --runner auto` — **all unit tests pass with a mock executor (no LLM, no
tokens)**, the loop is unchanged, the `--runner` default stays `stub`, `smoke:worker-loop` still passes
zero-cost, the runner **appends `REVO_RESULT_CONTRACT` to every prompt** (asserted by a unit test), and the
real-`claude` round-trip (Step 6) has been hand-verified to complete non-interactively (clean exit, within the
timeout) with the agent emitting a valid `REVO_RESULT` block when told only by the runner's appended contract.

---

## 8. Report back / open findings

Report:

1. The injectable-executor seam (`ProcessExecutor`) and the unit(mock) vs manual(real `claude -p`) split.
2. The exact `claude -p` flag set that yielded a non-interactive JSON round-trip (from Step 6), and the real
   transport-envelope shape observed.
3. The `REVO_RESULT` agent-envelope contract as implemented (the `REVO_RESULT_CONTRACT` constant), the fact that
   the **runner appends it to every prompt** (not `build-context.ts`, not the role `system_prompt`), and where
   `nextSteps` defaulting happens.
4. How timeout/error map to `lesson` through `failStep` (confirm no loop change).
5. `--runner` modes, the default, and the `resolveCwd` default.
6. Validation outputs (typecheck/lint:ci/test, `work --help`, `smoke:worker-loop`), and confirmation that the
   automated gate spent **zero** tokens.

Open findings / deferred (named later plans):

- **Codex runner** — second branch of `createRunAgent`/`runAgent`.
- **Plan 0009** — inbox row + approval resolution (this slice reuses `awaiting_approval` parking only).
- **Plan 0010** — multi-repo: per-task `repo_ref` → cwd, clone/container isolation. `resolveCwd` is the seam.
- **Plan 0011** — GitHub PR/commit automation + idempotent external create keyed on `attemptId`.
- **Data edit (no code):** grant roles real `allowed_tools` (e.g. developer Edit/Write/Bash) in the seed.
- **Default flip:** change `--runner` default to `auto` once the real round-trip and costs are trusted.

Needs human / ADR sign-off:

- Any change to `AttemptResult` / `RunAgent` shape forced by the real envelope (contract-level).
- Flipping the `--runner` default to `auto` (cost posture).
- The developer agent must not change architecture/ADRs on its own initiative — enforced by the role's
  `system_prompt` and scope, not by the runner.
