# Architecture overview

> The orienting doc. Read this before touching code or reviewing a change. It captures the **invariants** that
> are easy to violate and expensive to undo. When a change seems to require breaking one of these, stop and raise
> it — do not work around it.

## One paragraph

A local orchestrator runs software-development tasks using AI agents with distinct roles (triage, architect,
developer, tester, reviewer, integrator). **The only source of truth is Revisium.** Tasks, steps, roles, policy, the human
inbox, and domain data all live there. The orchestrator itself is a **thin, dumb loop**: it claims a ready step
from Revisium, runs a short-lived agent with the role and model that step names, and writes the result back. The
chain of work is **not hardcoded** — it emerges from step status changes in Revisium. A human steers through a
single inbox (approvals, answers to agent questions).

## Three layers

```text
[ Management + human ]   CLI / interactive: create tasks, work the inbox
            │  reads/writes state
[ Revisium — state bus ]  control plane (queue, inbox, roles, policy, cost)
            │                   + domain projects (ADRs, KB, repos)
[ Execution ]   orchestrator loop → spawns runners (Claude Code / Codex) in repos
```

Two independent forces turn the **same** state:

- **Autonomous loop** — a background process, runs without a human.
- **Interactive sessions** — a human + Claude Code, for creating tasks and resolving the inbox.

Both go through the **same data-access layer** into the same Revisium. By their effect they are
indistinguishable — both just change state. That symmetry is why work can move seamlessly between "do it live"
and "let the loop handle it."

## The five invariants (do not break without explicit sign-off)

1. **Revisium is the single source of truth.** No state in process memory, local files, or "live sessions."
   Anything that must survive one step lives in Revisium. This is what makes resume-after-interruption free.
2. **The loop is dumb and stable.** It does not know roles, workflow, or merge strategies. It does exactly one
   thing: claim a ready step → run it → write the result. All "intelligence" (which role, which model, what
   follows what) is **data in Revisium, not code.** Adding a role or a transition must require **zero** changes
   to the loop.
3. **Agents are short-lived.** A runner starts for one step and dies. There are no live sessions. "Continuing"
   work = a new process reads state from Revisium — never a revived old one.
4. **Schema knowledge is sealed in one layer.** Only the data-access (repo) layer knows Revisium's table
   structure. The loop and everything else speak in verbs (`claimNextStep`, `writeResult`), not tables. Schema
   changes → only that layer changes. See [repo-layer-contract.md](./repo-layer-contract.md).
5. **A human decision is a status change.** Inbox actions (approve / answer) do not command agents directly —
   they change data the loop reacts to on its next turn.

## What is data vs. what is code

| Data in Revisium (no loop change to evolve) | Code |
| --- | --- |
| Roles (prompt, model level, scope, runner) | The dumb loop |
| Model profiles (level → real model) | The data-access layer |
| Routing policy (which level, needs-human?) | The runner abstraction (`runAgent`) |
| Workflow — which step follows which | Strategy **engine** (executes any plan) |
| Strategies (recipes of dependency primitives) | Strategy **primitives** (the stable vocabulary) |

Adding a role, a transition, or a strategy is a **data** edit. Adding a new *mechanism* (a new primitive, a new
runner) is the only time the loop/engine code changes — so those must stay few and stable.

## The versioning boundary (critical)

Revisium has revisions (commits) and branches. Apply them **selectively**:

- **Versioned (commit / new revision):** ADRs, domain data, model policy, role definitions, strategies — the
  "ADR-worthy" changes where history and rollback matter.
- **NOT versioned (write to draft, never commit):** step statuses, the inbox, events, cost/token accounting —
  high-frequency runtime data. Committing a heartbeat or status flip would explode the revision count and
  degrade the instance.

The boundary runs **even inside the control plane**. Table-*schema* creation is committed once (structural,
ADR-worthy); runtime **rows** are written to draft and never trigger a commit. See
[control-plane-schema.md](./control-plane-schema.md) for which tables fall on which side.

## How the chain moves (the loop, in essence)

```text
// workerId is a STABLE identity, persisted across restarts (config / worker-id file) — not a per-process UUID,
// so a restarted worker reclaims the steps its previous incarnation owned.
recoverInFlight(workerId)                      // startup: reclaim only THIS worker's orphaned claimed/running steps
while (true) {
  step = claimNextStep(workerId, roles)        // a ready step, marked taken
  if (!step) { sleep; continue }               // nothing to do
  role    = loadRole(step.role)
  profile = loadModelProfile(role.model_level)
  context = buildContext(step)                 // STATE, not history (4 narrow layers)
  { attemptId } = startAttempt(step, ...)      // create the attempt row BEFORE any external effect
  result  = runAgent(role, profile, context, attemptId, step)
  if (result.needsHuman) pushInbox(...)        // park the branch; others continue
  else { writeResult(step, attemptId, ...); createSteps(result.nextSteps) }  // spawns the next roles
}                                              // on throw: failStep(step, attemptId, ...) → backoff / dead
```

`recoverInFlight` on startup is what makes "resume is free" true: a killed worker leaves steps `claimed`, and the
next process — running under the **same stable `workerId`** — resets *its own* orphans to `ready` before the loop
turns. Owner-scoping (not a global reset) keeps that correct once more than one worker exists. `startAttempt`
mints the `attemptId` up front so an external effect (PR/commit) is idempotent even if the worker dies mid-step.

The next roles in the pipeline come into being because a step wrote new `ready` steps — **not** because the loop
knows the pipeline. `buildContext` carries **state, not conversation history**: who I am (role + scope), what
we're doing (task + ADR verdicts), what's already done (artifacts + prior-attempt lessons), and the single thing
to do now. Cheap restarts depend on keeping that context narrow.

## Tools: which does what

- **`revisium-cli`** (`npx revisium`) — **batch / CI**: bootstrap projects, create tables, apply migrations,
  sync. Used for one-off structural operations, **not** runtime row writes.
- **`@revisium/client`** — **runtime transport**: the data-access layer is built on it (row read/write, claim a
  step, update status, push to inbox).

Locally, the control plane runs on a **standalone Revisium** daemon managed by the `revo` CLI (preferred port
`19222`; resolved port in `runtime.json`). See [getting-started.md](./getting-started.md). The base URL is
configurable, so the same data-access layer can later point at `cloud.revisium.io`.

## Anti-goals (things we deliberately do not do)

- Do **not** hardcode workflow / roles / strategies into the loop (data only).
- Do **not** version runtime (statuses / inbox / events / cost).
- Do **not** keep live sessions or in-memory state.
- Do **not** add queues / brokers / Temporal / agent frameworks — Revisium's Postgres handles this load profile.
- Do **not** build a write-capable Web UI (a read-only dashboard can come later; CLI is enough).
- Do **not** let the developer agent change architecture/ADRs on its own initiative.

## Where to go next

- Run it: [getting-started.md](./getting-started.md)
- The control-plane tables and the versioned/runtime split: [control-plane-schema.md](./control-plane-schema.md)
- The first build slice (daemon + bootstrap): [plans/0001-revisium-daemon-and-bootstrap.md](./plans/0001-revisium-daemon-and-bootstrap.md)
- The data-access contract (planned, front half of slice 0002): [repo-layer-contract.md](./repo-layer-contract.md)
