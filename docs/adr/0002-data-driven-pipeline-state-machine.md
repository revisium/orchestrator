# ADR-0002 — Data-driven pipeline state machine

- **Status:** Accepted (2026-06-19)
- **Amends:** [ADR-0001](./0001-execution-engine-and-host.md) §5 ("Workflow as code for the MVP") — the post-MVP
  goal it deferred is now delivered.
- **Design spec:** [plans/0015-pipeline-state-machine.md](../plans/0015-pipeline-state-machine.md) (the full node
  grammar, validation rules, and prior-art survey live there; this ADR records the decision and its consequences).
- **Context docs:** [architecture-overview.md](../architecture-overview.md) ·
  [control-plane-schema.md](../control-plane-schema.md)
- **Delivered by:** plan 0015, PRs #69–#75 (design #69; pure core #70; effect-adapter #72; data-driven cutover
  `19b6abb` #73; dead-code removal #74; default seeded pipeline #75); run-dataflow follow-up plan 0016 (#76, #77).

## Context

ADR-0001 §5 adopted **workflow-as-code for the MVP**: the pipeline (analyst → developer → reviewer → integrator)
was a single DBOS workflow *function*, and routing was decided by hardcoded role→phase classifiers in the engine
(`planRouteExecution` id-lists, the `isPreDeveloperAnalysisRole` insertion cluster, `validatePostIntegratorBindings`).
That relaxed the architecture's "the pipeline shape is **data**" invariant deliberately, to prove the DBOS engine
fast.

With the engine proven, those classifiers became the obstacle to the project's thesis ("method is data"): adding a
role, inserting a gate, or reordering steps meant editing engine code and its role-id lists, not editing versioned
data. The pipeline shape was the last large island of meaning still trapped in code.

## Decision

**Make the pipeline 100% data: a versioned graph template that a generic durable engine executes.** Concretely:

**1. The pipeline is a versioned graph template, not a function.** A template is a closed set of typed nodes
(`agent`, `script`, `humanGate`, `choice`, `parallel`, `join`, `wait`, `terminal`) with data-on-the-source-node
transitions (`next` / `branches` / `catch`). Guards are a **closed tagged union, never an expression string**
(v1 sources: `verdict.*` + `counter.*`) — un-reviewable embedded DSLs were rejected. Verdicts are **two-tier**:
core verdicts (`succeeded|failed|errored|timed_out`) route **structurally** (catch / onFailure / terminal /
gate-timeout) and never appear in branch guards; **domain** verdicts (`approved|blocker|changes_requested|…`) are
opaque labels matched by `branches`. Gate presence is therefore data, not a code path — `local-change` is the same
schema as `feature-development` minus the `humanGate` nodes. Full grammar + the 13 install-time validation rules:
plan 0015 §1–§12.

**2. Pure core + thin effect-adapter** (the XState/Temporal blueprint).
- **`src/pipeline-core/`** is a **pure, deterministic, I/O-free** module: `validateTemplate(t) -> Diagnostic[]`
  and `step(state, lastResult) -> { state, decision }` (an XState-style reducer that also computes scoped
  loop-counter values). Zero imports of DBOS, runners, or role-ids; clocks/randomness/live reads are banned (any
  such input is recorded data fed in). It is the authoritative validator and router.
- **The DBOS effect-adapter** (`src/pipeline/data-driven-task.workflow.ts`) is the **only I/O**: load the pinned
  template revision → `core.step()` → persist the returned state to DBOS → execute the emitted `decision` as a
  DBOS step (dispatch an `agent`/`script` via the existing runner seam; await a human via DBOS suspend/resume;
  fork via DBOS concurrent steps) → validate the result against the node's `resultSchema` and a gate verdict ∈
  `outcomes` → record the result/join-arrival as a durable step → feed it back as the next `lastResult`. The
  adapter is registered through the engine seam by **`PipelineService`** (invariant M1: nothing under
  `src/pipeline/*` imports `@dbos-inc/dbos-sdk` directly).

**3. Source-of-truth split unchanged (ADR-0001 invariant #1).** DBOS owns **progress** —
`{ activeNodeIds, scopedCounters, recordedStepResults, joinArrivals }`, the authoritative live execution state.
Revisium owns **meaning** and an eventually-consistent **projection** — `{ runId, templateRef, status, events[] }`
plus the gate inbox; node outputs/transcripts are stored **by reference**, never inlined. The race (fork/join
winners, cancelled siblings) is resolved by the adapter into durable recorded facts and fed to the pure core, so
the core never sees a live race (replay-determinism).

**4. Versioning by pin-at-start.** A run captures its template's Revisium **HEAD revisionId** at start and always
interprets against that pinned revision; HEAD edits affect only **new** runs. No in-code patch ladder (a data
template is structurally diffable). v1 ships only the migration **enablers** — the stable-node-id rule and a
safe/breaking **diff classifier** — not in-flight run migration.

**5. It is the sole engine.** Selection routes **every** pipeline to the data-driven engine; a pipeline lacking a
valid data-driven template **fails loud** at run start (`PIPELINE_NOT_DATA_DRIVEN`) rather than silently degrading.
The hardcoded `developTask` workflow and its role→phase classifiers were **removed** (`19b6abb`, #73/#74).

## Consequences

- **Removed:** the hardcoded role→phase classifiers (`planRouteExecution` id-lists, the `isPreDeveloperAnalysisRole`
  insertion cluster, `validatePostIntegratorBindings`) and the `developTask` workflow function. Adding/reordering a
  role or gate is now a **data** edit to a versioned `pipelines` row — no engine change.
- **Restored:** the "workflow = data" invariant (ADR-0001 §5; architecture-overview invariant #2). A future engine
  swap still only touches the thin adapter, not the template grammar or the pure core.
- **New module boundary to protect:** `src/pipeline-core/` is pure and owns the routing/validation invariants
  (plan 0015 §3/§6/§7). Do not add I/O, DBOS, or role-ids to it, and do not change its semantics without
  re-deriving those invariants. All effects live in the adapter.
- **Interim storage:** a template is a serialized `template_json` field in a versioned `pipelines` row, with
  `pipeline-core.validateTemplate` as the authoritative validator — Revisium's v1 meta-schema cannot natively type
  a recursive / discriminated-union / open-map graph. Native Revisium typing is a **strictly-additive** later
  upgrade (flip the field schema once the relevant Revisium ADRs ship; the pure validator stays as
  defense-in-depth).
- **Deferred (out of v1):** in-flight run migration (pin-only for now); native Revisium template typing;
  `diff.*`/`flag.*` guard sources (v1 grammar is `verdict` + `counter` only — additive later).
- **Safety net:** the pure core has unit tests; the data-driven e2e group exercises the adapter on real
  DBOS/Revisium (plan + merge gates to completion, crash-recovery, bounded-rework cap to `blocked`).

## Prior art

AWS Step Functions / Amazon States Language (single-doc JSON state machine, `waitForTaskToken` gates, version
pinning), BPMN 2.0 (user/service tasks, gateways, fork/join), Harel statecharts / W3C SCXML / XState (pure
interpreter + guarded transitions), Temporal (deterministic replay, pin-at-start versioning), Argo Workflows /
GitHub Actions (DAG + manual-approval ergonomics). Patterns were adopted selectively against the anti-goals — no
heavyweight framework, no ML/self-tuning; thin, typed, versioned, reviewable. Full survey: plan 0015 appendix.
