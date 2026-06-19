# Plan 0015 — Data-driven pipeline state machine (design spec v2)

> **Status: Landed** (#69–#75: design doc #69, then staged slices #70 core / #72 adapter / #73 cutover /
> #74 dead-code removal / #75 default pipeline). Grounded in prior-art across durable-workflow / state-machine
> systems (AWS Step Functions / Amazon States Language, BPMN, statecharts / SCXML / XState, Temporal, Argo /
> GitHub Actions) and iterated through internal review. Folds in the 10 locked product-owner decisions and closes
> the review findings (counter scope, verdict model, optional gate timeout, parallel shape + replay determinism,
> failure precedence, diff classifier).
> **Delivery:** this design doc → review → STAGED implementation slices behind the e2e net — all shipped; the
> data-driven engine is now the **sole** pipeline engine. See
> [adr/0002-data-driven-pipeline-state-machine.md](../adr/0002-data-driven-pipeline-state-machine.md).

## 0. Goal & invariants

Make the pipeline **100% data**: a graph of typed nodes + transitions, stored and versioned, that the engine
executes generically. The engine becomes a **generic durable step-executor + a built-in system-script library**
(integrator, pollers as scripts) + built-in roles — with **ZERO role-ids or pipeline shapes in code**. This
removes today's hardcoded role→phase classifiers (`planRouteExecution` id-lists, the `isPreDeveloperAnalysisRole`
insertion cluster) entirely.

Invariants (unchanged from the architecture overview / ADR-0001):
- **Revisium = MEANING** (versioned template; run inbox/projection). **DBOS = PROGRESS** (live execution state).
- **Pure state-machine core + thin DBOS effect-adapter** (XState/Temporal blueprint): the core is deterministic,
  I/O-free; the adapter performs all effects durably.
- v1 must express today's two pipelines: `local-change` (orchestrator + developer, no gate) and
  `feature-development` (analyst → reviewer[plan gate] → developer → reviewer[code] → integrator → watcher →
  merge gate, with reviewer-BLOCKER → developer rework, capped).
- Anti-goals: no heavyweight framework, no ML/self-tuning; thin, typed, versioned, reviewable.

## 1. Node (state) types — closed discriminated set

Every node has the envelope `{ id, kind, displayName? }`; `id` is permanent (never reused/repurposed — Temporal/
ASL stable-id rule). The closed `kind` set:

| `kind` | Purpose | Exit field(s) | Effect (Decision emitted by core) |
|---|---|---|---|
| `agent` | run a generic ROLE capability | `next` (+ `catch?`) | `invokeRole{ roleRef, input }` |
| `script` | run a built-in system SCRIPT (integrator, pollers) | `next` (+ `catch?`) | `invokeScript{ scriptRef, input }` |
| `humanGate` | suspend until an external verdict | `branches` (+ `timeout?`) | `awaitGate{ reason, outcomes, timeout? }` |
| `choice` | pure conditional routing, no effect | `branches` | — (interpreter evaluates guards) |
| `parallel` | fork into N named branches | `branches[]` + `join` | `fork{ branches, joinId, mode }` |
| `join` | converge branches with a mode | `joinMode`, `merge?`, `next` | — (interpreter aggregates recorded arrivals) |
| `wait` | timed auto-resume (rare; see note) | `next` | `startTimer{ duration }` |
| `terminal` | end the run | — | `complete{ status }` |

`agent`/`script` are distinct kinds (BPMN service-task vs user-task). `roleRef`/`scriptRef` are **opaque capability
handles** the adapter resolves — the engine holds no role-ids. **Note on `wait`:** kept in the enum, but v1 gate
SLAs are modelled as an OPTIONAL `timeout` field on `humanGate` (§6), not a separate `wait` node.

## 2. Template schema (the data model)

One template = one record (storage in §9). Top-level shape:

```jsonc
{
  "specVersion": "1.0",          // carries the CORE verdict vocabulary + engine semantics (§8)
  "pipelineId": "feature-development",
  "title": "...",
  "entry": "<nodeId>",           // single entry (validated)
  "verdicts": { "domain": ["approved", "blocker", "changes_requested", "clean", "dirty"] },  // §8
  "policy": { "conflicts": [["developer", "reviewer"]], "enforcement": "strict" },           // decorrelated review
  "scopes": { /* loop/counter scopes — §7 */ },
  "nodes": { "<nodeId>": { /* a Node from §1 */ }, ... }
}
```

The pinned identity of a run's template is the **Revisium HEAD revision id** (§11), not the integer shown in
examples for readability.

## 3. Transition + guard model — typed, NO-EVAL

Edges are **data on the source node** (ASL adjacency-by-name), separating WIRING from ROUTING (Argo `depends` vs
`when`):

- **`next`** (on `agent`/`script`/`wait`/`join`): single successor id (happy path).
- **`branches`** (on `choice`/`humanGate`): ordered `[{ when: <Condition>, goto }]`, first-true-wins, with a
  mandatory trailing `{ default: goto }`. Validation forbids a non-default guard after the default and requires a
  default (BPMN fail-loud; XState unguarded-last).
- **`catch`** (on `agent`/`script`): `[{ onError: <revo.*Code>, goto }]` — engine-emitted failure routing only
  (§6). `revo.*` is a reserved namespace, disjoint from verdict labels.

**`Condition` — a closed tagged union, NOT an expression string** (rejected JSONPath/FEEL/PowerFx — unanimous
un-reviewability). **v1 guard sources = verdict + counter only** (`diff.*`/`flag.*` deferred per decision; not in
the v1 grammar — add additively later):

```
Condition =
  | { op: "verdict.eq",  value: <VerdictLabel> }
  | { op: "verdict.in",  value: [<VerdictLabel>...] }
  | { op: "counter.lt",  scope: <scopeId>, value: int }
  | { op: "counter.gte", scope: <scopeId>, value: int }
  | { op: "all", of: [Condition...] }
  | { op: "any", of: [Condition...] }
  | { op: "not", cond: Condition }
```

**`verdict.eq`/`verdict.in` read the node's DOMAIN verdict field** (from the node's typed result; §8). **Core
verdicts (`succeeded|failed|errored|timed_out`) NEVER appear in branch guards** — they are routed STRUCTURALLY:
failure via `catch`/`onFailure`, gate timeout via `humanGate.timeout.goto`, completion via `terminal` (§6). A
node's success always proceeds via `next`; `catch` fires only on `revo.*` errors (the two are disjoint). Guard
evaluation is total: a non-boolean/erroring guard is an install-time validation error, never a silent false.
`counter.*` references a loop scope by its `scopeId` (§7).

## 4. Fork / join — shape + replay-determinism

A `parallel` node declares its branches and the matching join explicitly so the validator can enforce membership:

```jsonc
"reviewFanout": {
  "kind": "parallel",
  "branches": [ { "id": "a", "entry": "secReview" }, { "id": "b", "entry": "perfReview" } ],
  "join": "reviewJoin"
}
```

Each branch is a self-contained sub-graph entered at `entry`; branch nodes live in the global `nodes` map but a
branch may only `goto` within itself or to the declared `join` (validated, §12). The `join` node declares:

- **`joinMode`**: `all` (barrier — every branch must arrive) | `any` (first arrival proceeds) | `quorum{count:K}`.
  **`any`/`quorum` cancel the orphaned sibling branches by default** (best-effort; branch → `skipped`); `all` has
  nothing to cancel.
- **`merge`**: per-result-field reducer for fields written by >1 branch — `overwrite` (single-writer) or
  `appendByBranchOrder` (deterministic). **`lastWrite` is rejected in v1** (non-deterministic under replay).

**Replay determinism (consensus fix).** The adapter records each branch completion as a DBOS step with a
monotonic recorded sequence; the **join winner** (`any` = lowest recorded seq, branchId tie-break; `quorum` = first
K by that order) and the **skipped/cancelled set** are persisted as durable facts and fed into `core.step()` — the
core never sees the live race. Merge reducers run in that same canonical order. A sibling whose effect completes
after losing the cancel race is recorded but discarded for routing and marked `skipped`. Concurrency itself is
delegated to DBOS durable primitives (concurrent steps/child-workflows + await/join); `cursor.activeNodeIds` is a
set. (The exact DBOS join-arrival primitive is verified in implementation — §14 Q1.) The `fork` Decision's `mode`
mirrors its `join`'s `joinMode`; `joinMode` + `merge` are declared on the `join` node (§1).

## 5. (reserved — merged into §4)

## 6. Failure model + routing precedence

- **Transient retry is NOT in the spec** — DBOS owns durable retry (progress layer). The pure core never sees
  transient failure.
- **Gate timeout is OPTIONAL.** `humanGate.timeout?: { after, goto }`. **Absent ⇒ the gate waits indefinitely**
  (durable wait is free; legitimate for human-driven runs). Validation does NOT require a timeout; if present,
  `goto` must resolve and obey loop/scope rules. Timeout firing routes **directly via the gate's `timeout.goto`**
  (a recorded adapter event) — core verdicts are never matched by branch guards (§3), so a gate's `outcomes` carry
  only domain labels and the timeout path is the `timeout.goto` edge, not a `verdict.eq timed_out` branch.
- **Per-node failure policy + precedence (consensus fix).** Each `agent`/`script` carries
  `onFailure: "abort" | "route" | "escalate"` (default `abort`). Precedence on an engine error
  `revo.<Code>` (incl. an adapter `resultSchema` validation failure, §10):
  1. if a matching `catch[onError == code]` exists → route there;
  2. else apply `onFailure`: `abort` → `terminal:failed`; `route` → requires a matching `catch` (else it is an
     install-time validation error); `escalate` → requires `escalateTo: <nodeId>`, route there.
  Success results never enter this path — they always flow via `next`/`branches`.

## 7. Bounded rework loops + NESTED/scoped counters

A loop is a **backward `goto` gated by a `choice`**, bounded by a **named counter**; the interpreter enforces the
cap (never trust the agent to self-block). Per the locked decision, counters are **scoped and nestable with
reset**:

```jsonc
"scopes": {
  "codeReviewLoop": { "cap": 3, "parent": null }
  // the scope id IS the counter (one canonical identifier); a nested loop declares "parent": "codeReviewLoop";
  // entering a scope resets every descendant scope's counter
}
```

The **scope id is the single canonical counter identifier** — `scopes` keys, `incrementCounters`, and
`counter.*` guards all reference it (no separate counter name, removing the v1 scope-id-vs-name ambiguity).

- The **loop-entry node declares `incrementCounters: ["<scopeId>"]`** (explicit, node-declared — the single
  increment trigger; the interpreter does NOT also infer increments from back-edges, removing the v1 double-count
  ambiguity). The increment happens **in the pure core**: `step()` returns the next `state` with the scope's
  counter +1 (XState `assign` — a pure, deterministic, I/O-free state transition; the adapter then persists the
  returned state, §9/§10).
- **Reset:** entering a scope resets every descendant scope's counter (deterministic, in the core).
- Guards reference a scope (`{op:"counter.gte", scope:"codeReviewLoop", value:3}` → route to
  `terminal:blocked`/escalation).

## 8. Verdict model — two-tier

- **Core verdicts** are defined by `specVersion` (a dictionary the spec version carries: `succeeded | failed |
  errored | timed_out` + the terminal statuses). The **engine acts on these structurally** (catch / onFailure /
  terminal / timeout). Baking these from the versioned spec is legitimate — it is the spec contract, not ad-hoc
  engine hardcode.
- **Domain verdicts** are **declared per-template** in `verdicts.domain` (`approved | blocker |
  changes_requested | …`). The engine treats them as **opaque labels**: it only matches them against `branches`
  guards; "proceed/rework/block" is 100% in the routing data. A node's typed result (`resultSchema`) carries the
  domain verdict field; `humanGate.outcomes` must be a subset of `verdicts.domain`.
- **Validation:** every `verdict.eq`/`verdict.in` label ∈ (core ∪ `verdicts.domain`); a domain label may not
  shadow a core label; declared-but-unused and used-but-undeclared labels are both flagged (§12).

## 9. Storage + run format

**Template (MVP) = one serialized `template_json` field in one versioned `pipelines` row; the authoritative
validator is `pipeline-core.validateTemplate`** (Revisium gives versioning + the row, not internal typing).
Revisium's v1 meta-schema cannot natively type a recursive / discriminated-union / open-ended-map graph; the
capabilities are designed but `Proposed` (architecture ADR-0026 oneOf, 0028 pattern-properties, 0019 `$defs`,
0020 shared-components). **Native Revisium typing is a strictly-additive LATER upgrade** (flip the field schema
once those ADRs ship; `pipeline-core` stays as defense-in-depth) — resume handoff at
`~/Desktop/revisium-pipeline-schema-typing-handoff.md`. Single-record + draft/HEAD model is preserved.

**Run** = a separate record. Split per the invariant:
- **DBOS (authoritative PROGRESS):** `{ activeNodeIds:set, scopedCounters, recordedStepResults, joinArrivals }` —
  live execution state, suspend/resume, effect-once memoization, recorded join winners.
- **Revisium (eventually-consistent MEANING/projection):** `{ runId, templateRef:{pipelineId, revisionId},
  status, events[] }` — the inbox of gate decisions + the queryable run history/projection (never the control
  source). Node outputs/transcripts are stored **by reference** (`resultRef`), never inlined (Temporal 50MB/50k
  bound).

## 10. Engine module boundary

**`pipeline-core` (pure, own folder + tests, zero I/O / DBOS / role-ids):** spec types; `validateTemplate(t) ->
Diagnostic[]` (§12); **`step(state, lastResult) -> { state, decision }`** — a pure reducer (XState-style): it
returns the NEXT `state` (incl. updated/reset scoped counters and `activeNodeIds`) AND the effect `decision`.
Total + deterministic; clocks/randomness/live reads banned (any such input is recorded data fed in). The core
computes counter values; DBOS just persists them (§7/§9).

```
Decision =
  | { type:"invokeRole",   nodeId, roleRef,   input }
  | { type:"invokeScript", nodeId, scriptRef, input }
  | { type:"awaitGate",    nodeId, reason, outcomes, timeout? }   // timeout OPTIONAL (§6)
  | { type:"fork",         nodeId, branches, joinId, mode }
  | { type:"startTimer",   nodeId, duration }
  | { type:"complete",     status:"succeeded"|"failed"|"blocked" }
```

**DBOS adapter (the only I/O):** load pinned template revision → `core.step()` → **persist the returned `state`
(incl. `scopedCounters`, `activeNodeIds`) to DBOS** (authoritative for durability; the core computed the values) →
execute the `decision` as a DBOS step (dispatch agent/script via runners; await human via suspend/resume; fork via
DBOS concurrent steps; timer) →
**validate the result against the node's `resultSchema` at this boundary** (alongside token redaction; malformed →
`revo.ResultInvalid` → §6 precedence) and **validate a gate verdict ∈ `outcomes`** → record the result/join-arrival
as a durable step → feed the recorded result back as the next `lastResult`. Loop.

## 11. Versioning

- **Pin at start:** a run captures its template's Revisium HEAD **revisionId** in one field; in-flight runs always
  interpret against the pinned revision. HEAD edits affect only NEW runs. (Temporal PINNED; ASL `:N`; BPMN/Argo.)
- **No in-code patch ladder** (Temporal's exists because its workflow is code; our data template + pin makes it
  unnecessary — and a data spec can be structurally diffed, which is the advantage).
- **In-flight migration is OUT of v1** (pin-only). v1 ships only the enablers: the stable-node-id rule + the
  **safe/breaking diff classifier** (§12), so a future migration feature is buildable without re-deciding
  already-passed gates.
- **Retention:** keep all template revisions (no GC in v1); a revision pinned by a non-terminal run is
  non-deletable.

## 12. Validation rules (pure core, install-time)

`validateTemplate(t) -> Diagnostic[]`:

1. **Single entry** — `entry` resolves to exactly one node.
2. **References resolve** — every `next`/`branches.goto`/`branches.default`/`catch.goto`/`timeout.goto`/
   `escalateTo`/`parallel.branches.entry`/`join` points to an existing node; no dangling edges.
3. **Terminals** — every `terminal` has `status ∈ {succeeded,failed,blocked}` + no exit; every non-terminal has ≥1 exit.
4. **Total routing** — every `choice`/`humanGate` has a `default`; no non-default guard after the default.
5. **Reachability** — every node reachable from `entry`; no dead nodes.
6. **Loop-cap presence** — every back-edge belongs to a cycle whose `choice` has a terminating cap-guard
   (`counter.gte`) over a declared scope routing to a terminal/escalation; reject unbounded back-edges.
7. **Counter-scope well-formedness (new)** — every scope’s counter is declared; a counter’s reset scope is a
   strict ancestor of every node that reads/increments it; reject cross-scope/out-of-scope counter references; a
   counter scope may not span a `parallel`/`join` boundary (v1).
8. **Parallel/join well-formedness (new)** — every `parallel` has one matching `join`; branch nodes are members of
   exactly one branch; no cross-branch `goto` except to the declared join; for `all`, every branch reaches the
   join (no deadlock); for `quorum`, `K ≤ N`; any field written by >1 branch declares a `merge` reducer.
9. **Verdict-vocabulary closure (new)** — every `verdict.*` guard label ∈ `verdicts.domain` (core verdicts route
   structurally, never via branch guards — §3/§6); `humanGate.outcomes` ⊆ `verdicts.domain`; no domain label
   shadows a core label; flag unused-declared and used-undeclared labels.
10. **Conflict-matrix** — `policy.conflicts` checkable against node role bindings; flag any path where one actor
    fills both conflicting roles.
11. **Id/namespace hygiene** — node ids unique + match the id pattern; `revo.*` error codes never collide with
    verdict labels.
12. **Capability-ref shape** — every `roleRef`/`scriptRef` is a well-formed handle (the adapter confirms it
    resolves at run start).
13. **Diff classifier (new, enabler for future migration)** — `classifyTemplateDiff(old, next) -> safe |
    breaking | Diagnostic[]`: node-id delete/rename/`kind`-change = breaking; changing outgoing topology of an
    existing node = breaking; reusing a deleted id with a different kind/resultSchema = invalid; displayName/
    prompt/payload changes = safe. **Any field/path not explicitly classified defaults to `breaking` + a
    Diagnostic** (conservative); a complete field-by-field table (top-level, node envelope, kind-specific fields,
    edges, guards, scopes, `verdicts.domain`, policy, `resultSchema`, join settings) is produced during
    implementation. v1 only reports; it never migrates a live run.

## 13. Concrete example — `feature-development` (v2, internally consistent)

```jsonc
{
  "specVersion": "1.0",
  "pipelineId": "feature-development",
  "title": "Feature development with plan + merge gates and bounded rework",
  "entry": "analyst",
  "verdicts": { "domain": ["approved", "changes_requested", "blocker", "clean", "dirty"] },
  "policy": { "conflicts": [["developer", "reviewer"]], "enforcement": "strict" },
  "scopes": { "codeReviewLoop": { "cap": 3, "parent": null } },
  "nodes": {
    "analyst":     { "kind": "agent", "roleRef": "role:analyst", "resultSchema": "schema:plan", "onFailure": "abort", "next": "planGate" },
    "planGate":    { "kind": "humanGate", "reason": "plan-review", "outcomes": ["approved", "changes_requested"],
                     "branches": [
                       { "when": { "op": "verdict.eq", "value": "approved" }, "goto": "developer" },
                       { "when": { "op": "verdict.eq", "value": "changes_requested" }, "goto": "analyst" },
                       { "default": "blockedEnd" } ] },           // no timeout ⇒ waits indefinitely (§6)
    "developer":   { "kind": "agent", "roleRef": "role:developer", "resultSchema": "schema:change", "onFailure": "abort", "next": "codeReview" },
    "codeReview":  { "kind": "agent", "roleRef": "role:reviewer", "resultSchema": "schema:reviewVerdict", "onFailure": "abort", "next": "codeReviewRouter" },
    "codeReviewRouter": { "kind": "choice", "branches": [
                       { "when": { "op": "verdict.eq", "value": "approved" }, "goto": "integrator" },
                       { "when": { "op": "all", "of": [
                           { "op": "verdict.eq", "value": "blocker" },
                           { "op": "counter.lt", "scope": "codeReviewLoop", "value": 3 } ] }, "goto": "reworkDeveloper" },
                       { "default": "blockedEnd" } ] },
    "reworkDeveloper": { "kind": "agent", "roleRef": "role:developer", "resultSchema": "schema:change",
                       "incrementCounters": ["codeReviewLoop"], "onFailure": "abort", "next": "codeReview" },
    "integrator":  { "kind": "script", "scriptRef": "script:integrator", "resultSchema": "schema:integration",
                       "onFailure": "route", "catch": [{ "onError": "revo.ScriptFailed", "goto": "failedEnd" }], "next": "watcherPost" },
    "watcherPost": { "kind": "agent", "roleRef": "role:watcher", "resultSchema": "schema:watchVerdict", "onFailure": "abort", "next": "watcherRouter" },
    "watcherRouter": { "kind": "choice", "branches": [
                       { "when": { "op": "verdict.eq", "value": "clean" }, "goto": "mergeGate" },   // DOMAIN verdict, not core
                       { "default": "failedEnd" } ] },
    "mergeGate":   { "kind": "humanGate", "reason": "merge-review", "outcomes": ["approved", "changes_requested"],
                     "branches": [
                       { "when": { "op": "verdict.eq", "value": "approved" }, "goto": "mergedEnd" },
                       { "default": "blockedEnd" } ] },
    "mergedEnd":   { "kind": "terminal", "status": "succeeded" },
    "failedEnd":   { "kind": "terminal", "status": "failed" },
    "blockedEnd":  { "kind": "terminal", "status": "blocked" }
  }
}
```

`local-change` = the same schema with `entry: "orchestrator"`, `orchestrator` + `developer` agent nodes, and **no
`humanGate` node** — gate presence is data, not a code path.

## 14. Open questions for implementation (deferred to design review / build)

1. **DBOS fan-out primitive** — confirm whether concurrent branches are DBOS child-workflows vs concurrent steps,
   and exactly how join-arrival is detected + recorded (the canonical sequence). Verify against DBOS.
2. **Cancelled-sibling terminal contract** — define what the adapter does with an orphaned agent run whose effect
   completes after losing the `any`/`quorum` cancel race (record + discard for routing; mark `skipped`).
3. **`resultSchema` typing locus** — the adapter validates results (§10); confirm whether the schema lives in the
   playbook (as data) or is a built-in per-role contract.
4. **Native Revisium typing** — when ADR-0019/0026/0028 ship, flip storage from `template_json` to a typed schema
   (the Desktop handoff tracks this).

## Appendix — prior art

This design draws on established durable-workflow / state-machine systems: AWS Step Functions / Amazon States
Language (single-doc JSON state machine, `waitForTaskToken` gates, version pinning), BPMN 2.0 (user/service tasks,
gateways, fork/join), Harel statecharts / W3C SCXML / XState (pure interpreter + guarded transitions), Temporal
(deterministic replay, pin-at-start versioning), and Argo Workflows / GitHub Actions (DAG + manual-approval
ergonomics). Patterns were adopted selectively against the anti-goals (no heavyweight framework; thin, typed,
versioned, reviewable).
