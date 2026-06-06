# Roadmap & doc status

Living page: per-doc status, dependencies, and the build-slice roadmap. Updated as each slice lands. The
[docs index](./README.md) stays lean — this page absorbs the churn.

> **Pivot in effect.** The architecture moved from a hand-rolled dumb loop to a **NestJS host + DBOS durable
> engine + Revisium as source of truth** — see [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md).
> The pre-pivot plans (`0001–0018`) were dropped; this page tracks the new MVP slices and which reference docs are
> rewritten, partially superseded, or still in force.

## Doc status & dependencies

| Doc | Status | Notes |
| --- | --- | --- |
| [architecture-overview](./architecture-overview.md) | **Rewritten** | orienting doc, post-pivot |
| [adr/0001-execution-engine-and-host](./adr/0001-execution-engine-and-host.md) | **Accepted** | DBOS + NestJS decision |
| [control-plane-schema](./control-plane-schema.md) | Partially superseded | `steps`/`attempts` → DBOS; meaning tables stay |
| [inbox-and-gates](./inbox-and-gates.md) | Updated | gate mechanic via `DBOS.recv`/`send` |
| [open-questions](./open-questions.md) | Updated | Q1/Q3 resolved (engine concern); Q2/Q4/Q5 stand |
| [context-budget](./context-budget.md) | In force | `buildContext` reused as-is |
| [runner-contract](./runner-contract.md) | In force | runner abstraction reused |
| [repo-layer-contract](./repo-layer-contract.md) | Partially superseded | meaning verbs stay; progress verbs → DBOS |
| [multi-repo-strategies](./multi-repo-strategies.md) | Deferred | post-MVP (workflow-as-data) |
| [getting-started](./getting-started.md) | Rewritten in slice 0006 | two-process boot + DBOS |

## Build-slice roadmap — MVP (vertical slice)

Goal: prove **NestJS host + DBOS engine + Revisium SSOT** with one real pipeline end-to-end, CLI-driven,
two-process Postgres, human gates — a single run from `run create` to an open PR.

| Plan | Status | Scope |
| --- | --- | --- |
| [0001 — Nest host + DBOS bootstrap](./plans/0001-nest-host-and-dbos-bootstrap.md) | Draft | NestJS app, lifecycle, ensure Revisium up, create `dbos` db, `DBOS.launch`; prove Nest↔DBOS seam |
| [0002 — Revisium Nest module](./plans/0002-revisium-nest-module.md) | Draft | wrap existing data-access (roles/policy/inbox/run) as Nest providers |
| [0003 — DBOS pipeline workflow](./plans/0003-dbos-pipeline-workflow.md) | Draft | `developTask` workflow (code), steps call `runAgent`, stub runner end-to-end |
| [0004 — Human gates via DBOS + inbox](./plans/0004-human-gates-via-dbos-inbox.md) | Draft | plan + merge gates: `pushInbox` → `DBOS.recv`; `inbox resolve` → `DBOS.send` |
| [0005 — Real runners + integrator](./plans/0005-real-runners-and-integrator.md) | Draft | Claude Code runner as Nest service; integrator branch/commit/PR |
| [0006 — End-to-end MVP](./plans/0006-end-to-end-mvp.md) | Draft | one `revo` command boot→run→PR; dogfood; rewrite getting-started |

## After MVP (not scheduled yet)

- **Front-door adapters:** REST API (read-only dashboard first) + MCP server, over the same core.
- **Workflow as data:** a generic "execute plan" DBOS workflow that reads the next steps from Revisium —
  restoring the "workflow = data" invariant (ADR-0001 §5).
- **Multi-repo strategies:** primitives / engine / strategies (the old `multi-repo-strategies.md` design).
- **Learning memory:** cross-task KB recall ("we solved something like this before") feeding `buildContext` —
  the differentiating "agent memory" angle.
- **Pollers:** Sonar / CodeRabbit / CI poll + comment sorter (reuse `src/poller/pr-readiness.ts`).
- **Worktree isolation** for parallel runs touching the same repo.
- **Single process:** extract `startRevisium()` to boot Revisium in-process (ADR-0001 deferred option).
- **Post-MVP cleanup:** delete the legacy step-lifecycle verbs (`claimNextStep`/`startAttempt`/`writeResult`/
  `failStep`/`recoverInFlight`) and the dumb loop, now superseded by DBOS.
