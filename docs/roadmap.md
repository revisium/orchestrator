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
| [adr/0002-data-driven-pipeline-state-machine](./adr/0002-data-driven-pipeline-state-machine.md) | **Accepted** | pipeline-as-data engine; amends ADR-0001 §5 |
| [control-plane-schema](./control-plane-schema.md) | Partially superseded | `steps`/`attempts` → DBOS; meaning tables stay |
| [inbox-and-gates](./inbox-and-gates.md) | Updated | gate mechanic via `DBOS.recv`/`send` |
| [open-questions](./open-questions.md) | Updated | Q1/Q3 (engine) + Q2/Q4 resolved; only Q5 stands |
| [context-budget](./context-budget.md) | In force | `buildContext` reused as-is |
| [runner-contract](./runner-contract.md) | In force | runner abstraction reused |
| [repo-layer-contract](./repo-layer-contract.md) | Partially superseded | meaning verbs stay; progress verbs → DBOS |
| [multi-repo-strategies](./multi-repo-strategies.md) | Deferred | post-MVP |
| [getting-started](./getting-started.md) | Rewritten in slice 0006 | two-process boot + DBOS |

## Build-slice roadmap — MVP (vertical slice)

Goal: prove **NestJS host + DBOS engine + Revisium SSOT** with one real pipeline end-to-end, CLI-driven,
two-process Postgres, human gates — a single run from `run create` to an open PR.

| Plan | Status | Scope |
| --- | --- | --- |
| [0001 — Nest host + DBOS bootstrap](./plans/0001-nest-host-and-dbos-bootstrap.md) | **Landed** | NestJS app, lifecycle, ensure Revisium up, create `dbos` db, `DBOS.launch`; prove Nest↔DBOS seam |
| [0002 — Revisium Nest module](./plans/0002-revisium-nest-module.md) | **Landed** | wrap existing data-access (roles/policy/inbox/run) as Nest providers |
| [0003 — DBOS pipeline workflow](./plans/0003-dbos-pipeline-workflow.md) | **Landed** | `developTask` workflow (code), steps call `runAgent`, stub runner end-to-end |
| [0004 — Human gates via DBOS + inbox](./plans/0004-human-gates-via-dbos-inbox.md) | **Landed** | plan + merge gates: `pushInbox` → `DBOS.recv`; `inbox resolve` → `DBOS.send` |
| [0005 — Real runners + integrator](./plans/0005-real-runners-and-integrator.md) | **Landed** | Claude Code runner as Nest service; integrator branch/commit/PR |
| [0006 — End-to-end MVP](./plans/0006-end-to-end-mvp.md) | **Landed** | one `revo` command boot→run→PR; dogfood; rewrite getting-started |
| [0007 — Publishable alpha](./plans/0007-publishable-alpha.md) | **Landed** | `@revisium/orchestrator` packaging + seed test (PR #35) |
| [0008 — Alpha hardening](./plans/0008-alpha-hardening.md) | **Landed** | gh-account pinning, failure surfacing, per-attempt observability, params-as-data (PR #37) |
| [0009 — Playbook install](./plans/0009-playbook-install.md) | **Landed** (#45, #46) | Stage: D1-enabling; `revo playbook install` imports `@revisium/agent-playbook` catalogs as versioned meaning data |
| [0010 — Direct unit tests for parseOwnerRepo](./plans/0010-direct-unit-tests-parseownerrepo.md) | **Landed** (#42) | hardening: direct unit coverage for `parseOwnerRepo` |
| [0011 — MCP task development control plane](./plans/0011-mcp-task-control-plane.md) | **Landed** (#47) | Stage: D2-enabling; local stdio MCP front door for runs, inbox gates, playbooks/roles/pipelines, repository diagnostics, and route simulation |
| [0012 — MCP API service boundary](./plans/0012-mcp-api-service-boundary.md) | **Landed** (#48) | Stage: D2-enabling; keep MCP as transport and route product behavior through a protocol-neutral TaskControlPlane API service |
| [0013 — MCP PR readiness and feedback tools](./plans/0013-mcp-pr-readiness.md) | **Landed** (#49) | Stage: D2-enabling; read-only MCP PR readiness and actionable feedback tools over shared poller readiness logic |
| [0014 — Data-driven role `kind`](./plans/0014-data-driven-role-kind.md) | **Landed** (#67) | Stage: D4-enabling (method-is-data); a role declares an optional `kind` driving classification — first slice toward workflow-as-data, largely subsumed by 0015's full data-driven engine |
| [0015 — Data-driven pipeline state machine](./plans/0015-pipeline-state-machine.md) | **Landed** (#69–#75) | Stage: D4-enabling (workflow-as-data); pure `pipeline-core` reducer + DBOS effect-adapter executing a versioned graph template — the **sole** pipeline engine; hardcoded role→phase paths removed |
| [0016 — Run dataflow: step outputs as data](./plans/0016-run-dataflow.md) | **Landed** (#76, #77) | step outputs flow between nodes as typed data (the analyst's plan reaches the reviewer); structured agent verdicts via `claude --json-schema` |
| [0017 — Per-run git worktree isolation](./plans/0017-per-run-worktree-isolation.md) | **Landed** (#78) | Stage: D2-enabling; developer + integrator run in a per-run git worktree — concurrent same-repo runs isolated, base checkout never mutated |
| [0018 — PR review-feedback loop](./plans/0018-pr-review-loop.md) | **Landed** (#79–#81) | Stage: D2-enabling; observe CI/reviews → triage by type (CI→developer, review comment→analyst + reply/resolve, ambiguous→human gate) → merge gate |

Plan files under [docs/plans/](./plans/) keep their original authoring status headers (Draft, or "Landed —
retrospective record" for 0007/0008, which were documented after execution); this table is the source of truth
for landed status.

## Dogfooding ladder

How the orchestrator earns its own development work, stage by stage. Each stage has an entry bar and an exit
criterion; we do not skip rungs. **Rule: every new slice in this roadmap is tagged with the stage it is executed
in (D0/D1/…) — as a `Stage: Dn` marker in its roadmap-table Scope cell and in the plan file's status header.**
Slices 0001–0008 predate the ladder and are untagged. See [vision.md](./vision.md) for where the ladder leads.

- **D0 — playbook-driven manual development** *(current)*. Tasks run manually via the canonical agent playbook
  (Claude Code / Codex as orchestrator). Architecture, process, and vision work lives here.
- **D1 — revo runs satellite tasks on its own repo** *(enterable now)*. Small, low-risk, well-specified tasks —
  docs fixes, small tests, single-file refactors — via `revo run create --pipeline-id local-change --start --wait`, both gates on. Goal: collect
  failures as requirements. Exit: ~10 merged PRs authored by revo.
- **D2 — revo is the default for routine work.** All bugfix / small-feature tickets go through revo; the manual
  playbook process is reserved for architecture. Entry requires: PR-comment processing (the review-threads slice),
  `revo up` single process, MCP entry, digest.
- **D3 — full slices through revo.** Whole features plan → gate → code → review → PR. Entry requires: plan-gate
  comments (binary approve breaks on real features) and an analyst step (or an extended architect).
- **D4 — playbook/runtime convergence.** The workflow-as-data engine landed (plan 0015); convergence remains:
  roles/pipelines imported from `@revisium/agent-playbook` drive execution, and manual-run markdown becomes
  generated adapter output. After D4 a manual playbook run and a revo run are the same thing by construction.

## After MVP (not scheduled yet)

- **Playbook import:** Plan 0009 landed `revo playbook install` for local/package catalog import. Remaining
  follow-up: remote source resolution and using imported pipelines for route proposal.
- **Front-door adapters:** Plan 0011 landed the local stdio MCP entry. REST API / read-only dashboard remains
  unscheduled.
- ~~**Workflow as data**~~ ✅ LANDED (plan 0015) — a generic graph-executing DBOS workflow that reads its next
  steps from a versioned Revisium template, restoring the "workflow = data" invariant. It is now the sole engine
  (see [adr/0002-data-driven-pipeline-state-machine.md](./adr/0002-data-driven-pipeline-state-machine.md)).
- **Multi-repo strategies:** primitives / engine / strategies (the old `multi-repo-strategies.md` design).
- **Learning memory:** cross-task KB recall ("we solved something like this before") feeding `buildContext` —
  the differentiating "agent memory" angle.
- ~~**Pollers + review threads**~~ ✅ LANDED (plan 0018) — observe CI / Sonar / CodeRabbit, triage comments by
  type, reply in-thread + resolve (reuses `src/poller/pr-readiness.ts`); this is the PR-comment processing that
  gates D2.
- ~~**Worktree isolation** for parallel runs touching the same repo.~~ ✅ LANDED (plan 0017) — each live
  run executes in its own per-run git worktree (developer + integrator); concurrent same-repo runs are
  isolated and the user's base checkout is never mutated.
- **Single process:** extract `startRevisium()` to boot Revisium in-process (ADR-0001 deferred option). `revo up`
  as one process gates D2.
- **Post-MVP cleanup — mostly DONE.** The dumb loop (`src/worker/loop.ts`) and the dead step-lifecycle verbs
  (`claimNextStep`/`startAttempt`/`writeResult`/`failStep`/`recoverInFlight`/`createSteps`) are deleted (#85), and
  the phantom `steps` runtime path is retired (#86): no live path writes or reads a `steps` row anymore.
  `attempts` is **KEPT** — legitimate per-attempt provenance (`get_run_log` / verdict assertions), not duplication.
  **Only remaining:** drop the now-unused `steps` TABLE from `control-plane/bootstrap.config.json` (deferred — a
  schema drop on existing control-planes is riskier than retiring the writes; the table is marked DEPRECATED in the
  config + [control-plane-schema.md](./control-plane-schema.md) until then).
