# Data-access (repo) layer — contract

> The **only** module that knows Revisium's table structure (invariant #4 in
> [architecture-overview.md](./architecture-overview.md)). The loop and the interactive CLI call **these verbs**,
> never tables or HTTP directly. Schema changes → only this layer changes.
>
> This doc is the **contract** (interface + semantics). It also serves as the front half of the next build slice
> (Plan 0002: implement this layer on `@revisium/client`). Where a method's exact Revisium mechanic is still
> unverified, it is flagged **OPEN** and listed in [open-questions.md](./open-questions.md) — do not
> guess past those.

## Transport & placement

- Built on **`@revisium/client`** (runtime transport). `revisium-cli` is **not** used here — it is bootstrap/CI
  only.
- Base URL comes from the resolved standalone port (`~/.revisium-orchestrator/runtime.json`); org/project/branch
  from `revisium.config.json` (`admin` / `control-plane` / `master`). One place, injected — see
  [getting-started.md](./getting-started.md).
- **Revision targeting follows the versioning boundary** (invariant in
  [control-plane-schema.md](./control-plane-schema.md)):
  - **Runtime tables** (task_runs, tasks, steps, attempts, events, inbox, cost_ledger) → read/write the **draft**
    revision, **never commit**.
  - **Versioned tables** (roles, model_profiles, routing_policy) → **read the committed `head`** so the loop runs
    on approved definitions; edits to these happen out-of-band via a commit, not through hot-path writes.

## Types (shape, not final field list — see §5 of the plan / control-plane-schema.md)

```ts
type Status = string; // documented enums live in control-plane-schema.md

interface Step {
  id: string; taskId: string; runId: string;
  role: string; kind: string; status: Status;
  input: unknown; output: unknown;
  modelProfile: string; runAfter: string | null;
  attemptCount: number; maxAttempts: number; priority: number;
  leaseOwner: string | null; leaseExpiresAt: string | null;
  deadReason: string | null;
}

interface Role {
  id: string; name: string; systemPrompt: string;
  modelLevel: 'cheap' | 'standard' | 'deep'; effort: string;
  runner: 'claude-code' | 'codex'; allowedTools: string[];
  scopeRules: unknown;
}

interface ModelProfile {
  id: string; level: 'cheap' | 'standard' | 'deep';
  provider: string; modelId: string; params: unknown;
  costPerInput: number; costPerOutput: number;
}

interface InboxItem {
  id: string; kind: 'approval' | 'question' | 'alert';
  runId?: string; taskId?: string; stepId?: string; projectId?: string;
  title: string; context: unknown; options: string[];
  status: 'pending' | 'resolved'; answer?: unknown; resolvedBy?: string;
}

interface AttemptResult {        // what runAgent returns; shaped here for writeResult
  output: unknown; artifacts: unknown; nextSteps: NewStep[];
  costs: CostRecord[]; needsHuman?: boolean; lesson?: string;
}
```

## Methods

### Hot path (loop)

#### `claimNextStep(workerId: string, roles: string[]): Promise<Step | null>`
Pick one runnable step and mark it taken.
- **Select:** status `ready`, `runAfter <= now`, `role ∈ roles`, ordered by `priority` desc then `createdAt` asc.
- **Mark:** set `status = 'claimed'`, `leaseOwner = workerId`, `leaseExpiresAt = now + leaseTtl`. *(Lease fields
  are populated even though the MVP reaper is unused — invariant: they exist in schema from day one.)*
- Returns the claimed `Step`, or `null` if none.
- **MVP simplification:** with a single worker there is no claim race, so read-then-write is safe.
  **OPEN (§15.1):** Revisium atomic conditional update ("set claimed only if still ready"). Not needed now;
  when moving to multiple workers it plugs in **here** and nowhere else.
- Draft write, no commit.

#### `startAttempt(step: Step, opts): Promise<{ attemptId: string }>`
Create the attempt row **before** the runner executes — the id must exist ahead of any external effect, for
idempotency (brief §5/§9). The loop calls this after `buildContext` and before `runAgent`.
- mint `attemptId` and `idempotencyKey` **now**; insert an `attempts` row: `status = 'running'`, `stepId`,
  `runId`, `workerId`, `attemptNo = step.attemptCount + 1`, `modelProfile`, `startedAt`.
- set `steps[step.id].status = 'running'`.
- return `{ attemptId }`; `writeResult` / `failStep` use it to close the **same** row.
- Draft write, no commit.

#### `writeResult(stepId, attemptId, output, artifacts, costs): Promise<void>`
Record a successful step result, **consistently by meaning** (one logical commit of work):
- close `attempts[attemptId]`: `status = 'succeeded'`, `finishedAt`, tokens.
- append an `events` row (`type = 'step_succeeded'`, payload references artifacts).
- append `cost_ledger` rows (one per `CostRecord`).
- `steps[stepId]`: `status = 'succeeded'`, `output`, `updatedAt`.
- **OPEN:** Revisium has no documented cross-table transaction. Ordering: write `attempt`/`events`/`cost` first,
  flip `steps.status` **last**, so a crash mid-way leaves the step re-claimable rather than falsely succeeded.
- Draft write, no commit.

#### `createSteps(steps: NewStep[]): Promise<void>`
Insert the next steps in the chain (this is what makes the pipeline advance — invariant #2).
- New step `status = 'ready'` when its `dependsOn` are all satisfied, else `'pending'`.
- A new step starts a fresh attempt chain; its per-attempt `attemptId` is minted later by `startAttempt`, not
  here.
- Draft write, no commit.

#### `failStep(stepId, attemptId, lesson?, error?): Promise<void>`
Handle a failed attempt with backoff.
- close `attempts[attemptId]`: `status = 'failed'`, `finishedAt`, `lesson` (compressed takeaway, not raw logs),
  `error`.
- append `events` row (`type = 'step_failed'`).
- `steps[stepId]`: `attemptCount += 1`. If `attemptCount < maxAttempts` → `status = 'ready'`,
  `runAfter = now + backoff(attemptCount) + jitter`. Else → `status = 'dead'`, `deadReason`.
- Draft write, no commit.

#### `buildContext(step: Step): Promise<string>`
Assemble the **restart context** — state, not history (see [context-budget.md](./context-budget.md)).
Pure read. Four narrow layers:
1. **Who I am** — `role.systemPrompt` + scope (allowed/forbidden) from `loadRole(step.role)`.
2. **What we're doing** — the task + a **digest of ADR verdicts** (decisions, not the reasoning that produced
   them) + which repos.
3. **What's already done** — artifacts / PRs / touched files + **`lesson` from prior `attempts`** of this step.
4. **What's right now** — this single step (or one comment). The sole goal of the run.

Does **not** include: dialogue history, the whole repo (the agent reads it with tools), other tasks' ADRs, full
logs. Returns the assembled context string (or a structured object the runner serializes).

#### `recoverInFlight(workerId): Promise<Step[]>` — startup recovery (MVP-critical)
Reclaim in-flight steps **this worker identity** left behind when it crashed. **Required for the "resume is free"
guarantee** ([architecture-overview.md](./architecture-overview.md)) — so it runs even in the MVP, on **loop
startup**.
- **Owner-scoped:** reset steps with `leaseOwner === workerId` and status `claimed`/`running` → `ready`,
  **regardless of lease expiry** (an immediate restart leaves the lease still in the future — lease-only reaping
  would miss it). Owner-scoping is what keeps this safe when multiple workers later exist: a restarting worker
  reclaims **only its own** orphans, never another live worker's in-flight steps. No global "reset everything"
  sweep — that would be a hidden multi-worker footgun.
- **Requires a stable `workerId`** — persisted across restarts (from config or a worker-id file), **not** a
  per-process UUID. If the id changed on restart, the new process would own nothing and recover nothing. See the
  `workerId` note in the loop ([architecture-overview.md](./architecture-overview.md)).
- Close each orphaned `attempts` row as `failed` with `lesson = "worker crashed mid-step"`; append an `events`
  row (`type = 'step_recovered'`). Draft write, no commit.

#### `reapExpiredLeases(): Promise<Step[]>` — periodic / multi-worker (deferred)
The lease-gated counterpart that recovers **other** workers' orphans: reclaim steps with `leaseExpiresAt < now`
across any owner (safe to run while other workers are alive). Together with `recoverInFlight` (my own orphans, on
startup) this covers all crash cases. **Deferred** until multiple workers exist; the lease fields exist from day
one for exactly this. Draft write.

### Human inbox

#### `pushInbox(item: NewInboxItem): Promise<string>`
Create an inbox entry and park the step.
- insert `inbox` row; set the originating `steps[stepId].status = 'awaiting_approval'` (branch stops, siblings
  continue). Returns the inbox id. Redact secrets before writing. Draft write.

#### `resolveInbox(itemId, answer, resolvedBy): Promise<void>`
A human decision = a status change (invariant #5). Does **not** command an agent.
- `inbox[itemId]`: `status = 'resolved'`, `answer`, `resolvedBy`, `resolvedAt`.
- **Unblock:** create a continuation step (`status = 'ready'`) carrying the answer in its `input` (or flip the
  parked step back to `ready` with the answer attached). The loop revives the branch on its next turn with a
  fresh narrow context + the answer. Draft write.

#### `listInbox(filter?): Promise<InboxItem[]>` / `getInbox(id): Promise<InboxItem>`
Reads for the CLI / interactive session (the `inbox` / `show` commands).

### Definitions (versioned reads)

#### `loadRole(name): Promise<Role>`
Read the role definition from the **committed `head`** of the `roles` table. Draft edits to a role are not live
until committed — the loop always runs approved definitions.

#### `loadModelProfile(level): Promise<ModelProfile>`
Read the `cheap | standard | deep` → real-model mapping from `head` of `model_profiles`. Routing is by **named
level**, never by a raw model string, so "standard = model X today" changes in exactly one place.

#### `recordCost(record: CostRecord): Promise<void>`
Append a `cost_ledger` row. Draft write. (Usually called inside `writeResult`; exposed for standalone use.)

### Task creation (management side)

#### `createTask(input): Promise<{ runId: string; taskId: string }>`
Create a `task_runs` + `tasks` row (and optionally a first `triage`/`architect` step `ready`). Draft write.

#### `planRun(input): Promise<...>`
The richer entry point used after architect breakdown: materialize a run's tasks + initial steps from a plan.
Shape firms up with slice §10/§10.1; for MVP `createTask` is enough. **Defer the full signature.**

## Cross-cutting rules

- **Every runtime write targets draft and never commits.** A stray `create_revision` on the hot path is a
  defect — it would explode the revision count (versioning boundary).
- **Idempotency:** `attemptId` / `idempotencyKey` are **minted here** by `startAttempt` (before the run); the
  external-effect guard ("create PR/commit only if this key was not used") is enforced in the runner. `writeResult`
  / `failStep` must tolerate reconciling against an attempt row that `startAttempt` already created.
- **Consumers never see Revisium types.** Methods return the domain types above; mapping table-row ⇄ domain
  object stays inside this layer.
- **OPEN (§15.4):** exact row read/filter format and limits in `@revisium/client` for the hot `claimNextStep`
  query (server-side filter+sort vs. fetch+filter-in-process). Verify before implementing the select.
- **OPEN (§15.2):** exact `create_revision` mechanic for the rare versioned-table edits (roles/profiles/policy).

## Plan 0002 scope (when this gets built)

Implement, in this order, verifying each against a running standalone + the bootstrapped control plane:
`loadRole`, `loadModelProfile` → `createTask` → `claimNextStep` → `buildContext` → `startAttempt` →
`writeResult` + `createSteps` → `failStep` → `recoverInFlight` → `pushInbox` / `resolveInbox`.
`startAttempt` and `recoverInFlight` are **MVP-critical** (idempotency + crash recovery), not optional. Defer
only `reapExpiredLeases` (the lease-gated reaper), `planRun`, and the atomic-claim path. Resolve the BLOCKING
OPEN items (Q2, Q3) first and record the answers in [open-questions.md](./open-questions.md).
