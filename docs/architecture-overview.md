# Architecture overview

> The orienting doc. Read this before touching code or reviewing a change. It captures the **invariants** that
> are easy to violate and expensive to undo. When a change seems to require breaking one of these, stop and raise
> it — do not work around it.
>
> **Status: rewritten for the DBOS + NestJS pivot** (see [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md)).
> The earlier "thin dumb-loop over Revisium" design is superseded: a hand-rolled durable runtime is replaced by a
> real durable-execution engine. Some sibling docs still carry pre-pivot detail and are flagged accordingly; the
> roadmap tracks what gets rewritten in which slice.

## One paragraph

A local **host process** runs software-development tasks using AI agents with distinct roles (analyst, developer,
reviewer, integrator). The host is a **NestJS application**: one process, several front doors (CLI now; REST and
MCP later) over one core. Durable execution — running a task to completion across crashes, retries, and human
pauses — is handled by **DBOS** (a durable-workflow library backed by Postgres), not by hand-written loop code.
**Revisium is the source of truth for *meaning*:** roles, model policy, the human inbox, the event journal, and
domain data. **DBOS is the source of truth for *progress*:** which step ran, what it returned, what's queued, what
to resume. A human steers through one inbox (approvals, answers to agent questions). Short-lived agents do the
actual work, one step at a time.

## Three layers

```text
[ Host — NestJS process ]   front doors: CLI (now), REST + MCP (later) over one core
            │  drives
[ Engine — DBOS ]           durable workflows + queues + retries + human waits (its own Postgres tables)
            │  reads/writes meaning
[ Revisium — source of truth ]  roles, model policy, inbox, events, domain data
            │  spawns
[ Execution ]   short-lived runners (Claude Code / codex / script) in target repos
```

Two forces turn the **same** durable state: the **autonomous engine** (DBOS workflows running without a human) and
**interactive sessions** (a human + CLI, creating tasks and resolving the inbox). Both go through the **same Nest
providers** into the same DBOS + Revisium. By their effect they are indistinguishable — both just change state.
That symmetry is why work moves seamlessly between "do it live" and "let the engine handle it."

## The five invariants (do not break without explicit sign-off)

1. **Two sources of truth, cleanly split.** **Revisium** owns *meaning* — roles, model policy, inbox, events,
   memory, domain data. **DBOS** owns *progress* — workflow/step status, step outputs, queues, what to resume.
   Nothing durable lives in process memory or local files. This split is what makes resume-after-interruption free
   *and* keeps the auditable/versioned data in the store built for it.
2. **The engine is swappable; routing is behind a thin layer.** DBOS is reached only through a small set of host
   verbs (start a run, run a step, wait for a human, signal a decision). Swapping the durable engine must not
   touch roles, runners, or Revisium access. **For the MVP the workflow is *code*** (a DBOS workflow function);
   making the workflow *data* (a generic "execute plan" reading steps from Revisium) is a deliberate post-MVP
   goal, not a regression — see [adr/0001](./adr/0001-execution-engine-and-host.md).
3. **Agents are short-lived.** A runner starts for one step and dies. There are no live sessions. "Continuing"
   work = a new process reads state and runs the next step — never a revived old one.
4. **Store knowledge is sealed in one layer each.** Only the Revisium data-access module knows Revisium's table
   structure; everything else speaks verbs (`loadRole`, `pushInbox`, `createRun`). DBOS's own tables are never
   read directly — only through DBOS APIs. Schema changes stay contained.
5. **A human decision is a state change.** Inbox actions (approve / answer) do not command agents directly — the
   human resolves an inbox row in Revisium, which signals the parked DBOS workflow (`DBOS.send`) to resume on its
   next turn.

## What is data vs. what is code

| Data — evolve without engine/host change | Code |
| --- | --- |
| Roles (prompt, model level, scope, runner) — in Revisium | The host (NestJS app, lifecycle, DI) |
| Model profiles (level → real model) — in Revisium | The Revisium data-access module |
| Routing policy (which level, needs-human?) — in Revisium | The runner abstraction (`runAgent`) |
| The pipeline shape (**MVP: code**; post-MVP: data) | The DBOS workflow(s) + the thin engine layer |

Adding a role or editing policy is a **data** edit in Revisium. Adding a new *mechanism* — a runner, a front-door
adapter, a workflow primitive — is **code** (a NestJS module / plugin). Keep mechanisms few and stable.

## The plugin / data boundary

- **Plugins are code:** runners (`claude-code`, `codex`, `script`), front-door adapters (CLI/REST/MCP), and later
  workflow primitives. They are NestJS modules wired by DI.
- **Method is data:** roles, strategies, routing policy — versioned rows in Revisium.
- The trap to avoid: making *roles* into plugins. A new *way to do something* is a plugin; a new *thing to do* is
  data. Crossing that line dissolves invariant #1.

## The versioning boundary (critical)

Revisium has revisions (commits) and branches. Apply them **selectively**:

- **Versioned (commit / new revision):** ADRs, domain data, model policy, role definitions, strategies — the
  "ADR-worthy" changes where history and rollback matter.
- **NOT versioned (write to draft, never commit):** the inbox, events, cost/token accounting — high-frequency
  runtime data in Revisium. Committing a status flip would explode the revision count.
- **Not in Revisium at all:** execution progress (workflow/step status, attempts, leases) lives in **DBOS's
  Postgres**, never in Revisium. The pre-pivot `steps` / `attempts` runtime tables are gone from the control
  plane — DBOS owns them. See [control-plane-schema.md](./control-plane-schema.md).

## How a run moves (in essence)

```text
// One Node process. NestJS boots; DBOS.launch() recovers any in-flight workflows automatically.
createRun(input)                  // writes run/task to Revisium; starts the DBOS workflow (id = runId)

// DBOS workflow developTask(runId) — durable, survives crashes:
  analyst   = runStep('analyst',   ...)   // each step calls runAgent(role, profile, context)
  awaitHumanApproval('plan', ...)         // pushInbox(Revisium) → await DBOS.recv(); siblings keep running
  developer = runStep('developer', ...)
  review    = runStep('reviewer',  ...)   // loop to developer on BLOCKER/MAJOR
  integrator= runStep('integrator',...)   // branch → commit → PR (idempotent by step id)
  awaitHumanApproval('merge', ...)        // agents never merge
```

`runAgent` is reused as-is across runners; `buildContext` carries **state, not conversation history** (who I am,
what we're doing, what's already done, the one thing now). DBOS checkpoints after each step, so a killed process
resumes from the first unfinished step — no hand-rolled `recoverInFlight`, leasing, or backoff.

## Tools: which does what

- **`@revisium/client`** — runtime transport for *meaning*: the Revisium data-access module reads roles/policy
  (committed `head`), writes inbox/events (draft), reads/writes domain data.
- **`revisium-cli` (`npx revisium`)** — batch / structural: bootstrap projects, create tables, migrations.
- **DBOS (`@dbos-inc/dbos-sdk`)** — durable execution. Connects to Postgres and owns progress state. **No second
  Postgres dependency:** it connects as a client to the embedded Postgres that Revisium standalone already runs,
  using a separate `dbos` database. See [adr/0001](./adr/0001-execution-engine-and-host.md).

Locally (MVP) Revisium runs as a **separate standalone process** (the `revo` daemon) owning one embedded Postgres;
the host connects to both as a client. Collapsing Revisium into the host process (`startRevisium()`) is a deferred
option, not the MVP.

## Anti-goals (things we deliberately do not do)

- Do **not** hand-roll durable execution (leasing, retries, recovery) — that is DBOS's job now.
- Do **not** make roles/strategies into code plugins (they are data in Revisium).
- Do **not** version runtime (inbox / events / cost); do **not** put execution progress in Revisium.
- Do **not** keep live sessions or in-memory durable state.
- Do **not** build a write-capable Web UI yet (read-only dashboard later; CLI is enough).
- Do **not** let the developer agent change architecture/ADRs on its own initiative.

## Where to go next

- The decision record for this architecture: [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md)
- The MVP build slices: [roadmap.md](./roadmap.md) and [plans/](./plans/)
- The control-plane tables (post-pivot) and the versioning split: [control-plane-schema.md](./control-plane-schema.md)
- Human control (inbox + gates): [inbox-and-gates.md](./inbox-and-gates.md)
