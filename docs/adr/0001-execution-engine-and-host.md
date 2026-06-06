# ADR-0001 — Execution engine (DBOS) and host framework (NestJS)

- **Status:** Accepted
- **Supersedes:** the "thin dumb-loop over Revisium" runtime (pre-pivot plans `0001–0018`, dropped from the tree)
- **Context docs:** [architecture-overview.md](../architecture-overview.md) · [roadmap.md](../roadmap.md)

## Context

The orchestrator was built as a **thin dumb loop**: a `while(true)` that claims a ready step, runs it, writes the
result (`src/worker/loop.ts`, `src/control-plane/steps.ts`). To make that survive crashes and concurrency it grew
the machinery of a durable-execution engine by hand — `lease_owner`/`lease_expires_at`, `attempt_count`/backoff,
`idempotency_key`, `dead_reason`, `recoverInFlight`. Two open questions blocked correctness:

- **Q1** — does Revisium support an atomic compare-and-set ("claim only if `ready`")? Needed before >1 worker.
- **Q3** — does Revisium offer server-side filter/sort/pagination for an efficient claim query?

Both are exactly what a durable-execution engine solves for free. Maintaining a self-built engine on top of a
store that is not designed as a task queue is the wrong cost.

Separately, the system is no longer "just a loop": it is becoming a **host process** with several front doors —
CLI now, and likely REST + an MCP server — plus lifecycle management of a Revisium standalone, all over one core,
with a plugin ambition.

## Decision

**1. Adopt a durable-execution engine; do not hand-roll one. The engine is DBOS.**

DBOS is a TypeScript **library** (not a separate server) that stores durable workflow state in Postgres:
checkpointing after each step, automatic recovery on restart, queues with concurrency limits (replacing the claim
loop and leasing — and Q1/Q3), idempotency by workflow id, durable sleep, and `send`/`recv` for human waits.

Alternatives considered:
- **Restate** — capable, but a separate runtime binary to bundle per platform.
- **Temporal** — most mature / enterprise-trusted, but a heavy server; wrong fit for "ship inside a local package."

Deciding criterion: **the product must install as a package on an end device with no extra infrastructure.** DBOS,
being an in-process library over Postgres, wins for local-first. The engine sits behind a thin host layer
(invariant #2), so a future enterprise client demanding Temporal is a swap, not a rewrite.

**2. The host is a NestJS application.**

Rationale: multiple front doors (CLI/REST/MCP) over one core is a DI-container case; the plugin ambition maps to
Nest `DynamicModule`; lifecycle hooks (`OnApplicationBootstrap` / `OnApplicationShutdown`) are the natural home for
`DBOS.launch()` / `DBOS.shutdown()`; and it is the **house stack** — both `revisium-core` and `ved-backend` are
NestJS 11. The CLI runs via a Nest standalone application context (no HTTP needed until REST/MCP land).

**3. Source-of-truth split.** Revisium owns *meaning* (roles, policy, inbox, events, domain data); DBOS owns
*progress* (workflow/step status, queues, resume). The pre-pivot `steps`/`attempts` control-plane tables are
retired — DBOS owns that runtime.

**4. One Postgres dependency (MVP = two processes).** Revisium standalone owns the single embedded Postgres
(`embedded-postgres`, a real Postgres binary — confirmed in `@revisium/standalone`). DBOS connects to that same
server as a plain `pg` client, using a separate `dbos` database (`embedded-postgres` exposes `createDatabase`).
The host reads the resolved pg port from Revisium's runtime (`runtime.json` / `pgdata/postmaster.pid`), never
hardcodes it. No second Postgres is bundled.

**5. Workflow as code for the MVP.** The pipeline (analyst→developer→reviewer→integrator) is a DBOS workflow
*function*. This temporarily relaxes the "workflow = data" invariant in favour of proving the engine fast. Making
the workflow generic (an "execute plan" that reads steps from Revisium data) is a tracked post-MVP goal.

## Consequences

- **Removed:** Q1 and Q3 (engine concern now); hand-rolled leasing/backoff/recovery; the dumb loop. The
  `claimNextStep`/`startAttempt`/`writeResult`/`failStep`/`recoverInFlight` verbs become legacy and are dropped in
  a post-MVP cleanup.
- **Reused unchanged:** the runner abstraction (`runAgent`, `AttemptResult`), the Claude Code / script / stub
  runners, `result-envelope`, `build-context`, `process-executor`, and the Revisium data-access verbs for
  meaning (`loadRole`, `loadModelProfile`, `createRunWorkflow`, inbox verbs).
- **New seam to validate:** DBOS decorates static workflow methods; NestJS providers are DI instances. The two
  compose, but the integration must be set up deliberately once (registering instance-bound workflows). Slice
  0001 proves it with a trivial durable workflow invoked from the CLI.
- **Deferred, not closed:** embedding Revisium in the host process via an exported `startRevisium()` (one
  process); REST + MCP adapters; workflow-as-data.

## Deferred options (revisit when MVP proves out)

- **Single process:** extract `startRevisium()` from `revisium`'s standalone CLI so the host boots Revisium
  in-process. Trade-off: simpler packaging vs. shared-fate (one crash takes both down). MVP keeps two processes
  for isolation.
- **Engine swap to Temporal/Restate** if an enterprise deployment requires it — contained by the thin engine
  layer.
