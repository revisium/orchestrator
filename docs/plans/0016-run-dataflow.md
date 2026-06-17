# 0016 — Run dataflow: step outputs as data

Status: **Revised after analyst + claude consensus (codex pending).** Verdict was **NEEDS-REVISION**;
this v2 folds the findings in. Builds on [0015](./0015-pipeline-state-machine.md).
Engine: `src/pipeline-core/` (pure) + `src/pipeline/data-driven-task.workflow.ts` (DBOS adapter).

## 0. Motivation — what's broken

A `feature-development` run on a fresh repo surfaced two coupled defects:

1. **The analyst's plan never reaches the planReviewer.** The adapter invokes every agent with
   `{ nodeId }` only (`invokeRole`). `lastResult` carries `{ outcome, verdict }` (routing), never content.
   The analyst emits a schema-validated plan; the adapter validates it, then **discards the content** and
   keeps `{succeeded, approved}`. The planReviewer (read-only, runs in the repo) finds no plan → `blocker`.
2. **A review verdict with no router is inert.** `planReviewer.next = planGate` is unconditional, so the
   `blocker` is recorded but ignored (contrast `codeReviewRouter`/`watcherRouter`, which ARE `choice`s).

Defect 2 is a template fix (add a `choice` router). Defect 1 is the real gap: **the engine has no model
for content flowing between steps.** This doc designs that model — and, per the consensus review, fixes a
**latent 0015 bug** it depends on (§4.1).

## 1. Two layers, kept separate

| Layer | Carries | Size | Consumed by | Lives in |
|---|---|---|---|---|
| **Routing signal** | `outcome`, `verdict`, counters, **+ per-node entry ordinal (new)** | bytes | the SM core (guards, ordinals) | `RunState` → DBOS progress |
| **Step output** (NEW) | the plan, review findings, integration report | KB+ | the next **agent** (in its prompt) | Revisium `run_outputs` (this doc) |

Industry parallel: Step Functions / Temporal pass a small JSON state; Argo splits tiny `parameters` from
large `artifacts` (store + reference); LangGraph uses a typed shared-state object. We keep the minimal
routing-state path (0015) and add a **separate content channel** (store + declarative references). We do
NOT widen `lastResult` to carry content.

**Decisions (user):** content → **Revisium** (versioned meaning, per-run); code/diff → **git** (run
branch), never Revisium; only a small pointer (`{branch, headSha, prUrl}`) may be a step output (§9).

## 2. Data model — `run_outputs`

Each node EXECUTION appends one immutable row:

```
run_outputs {
  id          // deterministic: out_${fnv1a64Hex(`${runId}|${nodeId}|${ordinal}`)}  (≤64, matches events/cost)
  run_id, node_id
  ordinal     // CORE-computed per-(run,node) entry ordinal: 1,2,3… across loop re-entries (§4.1)
  name        // artifact name from the node's produces.name, e.g. "plan"
  schema_ref  // resultSchema it was shape-checked against, e.g. "schema:plan"
  payload     // serialized JSON content, secret-redacted + SIZE-CAPPED at the adapter boundary (§8)
  payload_ref // optional: when payload exceeds the cap, a reference instead of inline content (§8)
  attempt_id  // joins to the per-attempt process artifact (attempts row)
  produced_at
}
```

- **Key** `(run_id, node_id, ordinal)`. *Latest* = `max(ordinal)`.
- **Append-only** — never updated/deleted → full history for retro/audit.
- **Per-run, draft scope** (like `events`/`inbox`): rows live in the draft, never committed (§8).
- `ordinal` is the **core's** per-node entry counter (§4.1), NOT a counted row-scan and NOT the loop
  counter. This is the load-bearing change from v1 (consensus B1–B3).

## 3. Template declarations — `produces` / `consumes`

Optional fields on `agent`/`script` nodes (`EffectNodeFields`):

```jsonc
"analyst":   { "kind":"agent", "roleRef":"role:analyst",  "resultSchema":"schema:plan",
               "produces": { "name": "plan" }, "next": "planReviewer" },
"developer": { "kind":"agent", "roleRef":"role:developer","resultSchema":"schema:change",
               "consumes": [ { "node": "analyst", "as": "plan" } ], "next": "codeReview" }
```

```ts
type ProducesDecl = { name: string };                      // v1: one named output per node
type ConsumesRef = {
  node: string;                                            // any earlier node id (not just predecessor)
  as: string;                                              // key in the hydrated "## Inputs" section
  iteration?: 'latest' | 'all' | number;                  // default 'latest'
  optional?: boolean;                                      // default false → missing = fail-loud (§6)
  staleOk?: boolean;                                       // ack a loop-freshness risk (§7 CONSUMES_STALE_RISK)
};
```

### Capabilities (v1) — and the user's questions answered

| Capability | v1 | How |
|---|---|---|
| Consume from a **specific earlier node** (not just predecessor) | ✅ | `{ node: "analyst" }` |
| Consume from **multiple nodes** at once | ✅ | list of refs (distinct `as` keys — `CONSUMES_AS_DUP` else) |
| **Latest** loop iteration (default) | ✅ | `iteration:'latest'` → `max(ordinal)` |
| **All** iterations (history for meta-review) | ✅ | `iteration:'all'` → array (resolved in a memoized step, §6) |
| A **specific** iteration | ✅ | `iteration:N` (1-based ordinal); unsatisfiable required N → `revo.InputMissing` |
| **Optional** input | ✅ | `optional:true` |
| Produce one named artifact per node | ✅ | `produces:{name}` |

**Deferred to v2:** multiple named outputs per node; cross-`parallel`-branch consume; field
projections/transforms; cross-run consumption.

## 4. Loops, history, and the ordinal (the core change)

### 4.1 Per-node entry ordinal lives in the core (fixes a latent 0015 bug)

**Consensus B1–B3 / Q4.** A deterministic `seq`/`ordinal` cannot be invented by the adapter: counting
rows is a live read (differs on DBOS replay); wall-clock is forbidden. Worse, the adapter today reuses
`stepKey = nodeId` on **every** loop iteration, so the deterministic `attemptId`/event-id **collide across
iterations** — later iterations ROW_CONFLICT and are silently dropped. So 0015 already loses per-iteration
history for attempts/events; `iteration:'latest'/'all'` would be built on sand.

**Fix — adapter-owned execution ordinal; `interpret.ts` stays UNCHANGED** (codex #3, the cleaner synthesis:
keep the core pure). The `runBody` loop is itself **replay-deterministic** — DBOS re-runs the workflow
body, `coreStep` is pure, and effects are memoized steps. So the adapter keeps a **workflow-local**
`effectOrdinalByNode: Map<nodeId, number>`, incremented each time it executes an effect for a node —
rebuilt identically on replay. The ordinal drives:
- `stepKey = ${nodeId}#${ordinal}` → distinct attempts/events **per iteration** (this ALSO fixes the latent
  0015 bug — own it here);
- `run_outputs.ordinal` + the row id `out_${fnv1a64Hex(runId|nodeId|ordinal)}` → idempotent on replay.

The core decides **which node**; the adapter decides the deterministic **execution instance**. No
`RunState`/`Decision` change, no row-counting (a live count would differ on replay). The core still stores
no content — content stays adapter+Revisium.

### 4.2 History vs reset

Routing and data are decoupled: **loop counters reset** on re-entry (unchanged, bounds rework); **step
outputs are append-only, never reset.** Iteration N of `developer` writes `(developer, ordinal=N)`.

- `iteration:'latest'` → most recent rework (the 99% case).
- `iteration:'all'` → full history (meta-review).
- **Retro/audit**: `outputsForRun(runId)` ordered by `produced_at` reconstructs the whole run.

## 5. Responsibilities — core / adapter / Revisium

| Layer | Owns |
|---|---|
| **pipeline-core** (pure) | `produces`/`consumes` types; **static validation** (§7). `interpret.ts` UNCHANGED — no `RunState`/`Decision` change, NO content, NO I/O. |
| **adapter** (DBOS) | owns `effectOrdinalByNode` + a **workflow-local output accumulator** (§4.1/§6). **before** effect → resolve `consumes` from the accumulator (NOT live Revisium reads), hydrate prompt; precondition → `revo.InputMissing` (§6). **after** → shape-check vs `resultSchema`, redact + cap, **persist** `produces` to Revisium as an idempotent side-effect. stepKey = `${nodeId}#${ordinal}`. |
| **Revisium** | `run_outputs` table (draft scope); write + read latest/all/for-run. |
| **git** | code + diff (run branch); only a pointer may be an output. |

## 6. Hydration & fail-loud precondition

**Before** a node runs, the adapter resolves `consumes` from its **workflow-local output accumulator** (the
same structure feeding `effectOrdinalByNode`), NOT from live Revisium queries (consensus M4 / codex #4: a
live `allOutputs` on replay can see rows written past the replay point → different hydration). The
accumulator is rebuilt deterministically by replay from the memoized effect results; Revisium reads serve
CLI/retro only.
- For each ref: read from the accumulator (`latest`=max ordinal, `all`=array, `N`=that ordinal).
- Found → add under `as` → the runner injects a **`## Inputs (from previous steps)`** markdown section.
- A **required** ref with no output → the step is a **terminal-by-construction engine fault**
  `revo.InputMissing` that emits a dedicated `step_failed`/`pipeline_blocked` event naming `(node, as)` and
  fails the run — it does **not** depend on the template declaring a `catch` (consensus M3). Optional
  missing refs are omitted. This is fail-loud and clearly attributed — distinct from a domain `blocker`.

**After** a node runs: shape-check vs `resultSchema` (the existing MVP check — full JSON-schema validation
is out of scope, noted as a known limitation, consensus A7), **redact + size-cap** the payload, persist the
`produces` row. Routing (`{outcome, verdict}`) unchanged.

## 7. Validation rules (new — `validate.ts`, group "14 dataflow")

New `DiagnosticCode`s:
- `CONSUMES_NODE_UNRESOLVED` — `consumes.node` is not a node id (error).
- `CONSUMES_PRODUCER_MISSING` — referenced node declares no `produces` / can't produce (error).
- `CONSUMES_NOT_DOMINATED` — producer does **not dominate** the consumer (a real **dominator-tree**
  computation over structural edges — NOT plain reachability, consensus M2). Error if required, warning if
  `optional`. **The entry node may not be a consumer** (it has no dominating producer) → error.
- `CONSUMES_STALE_RISK` — the consumer sits in a cycle re-enterable **without** the producer and uses
  `iteration:'latest'` without `staleOk` → it may silently reuse a stale output (codex #5 / claude M2:
  dominance proves presence, not **freshness**; needs SCC/back-edge analysis). Warning. `iteration:'all'`/`N`
  or `staleOk:true` suppress it.
- `CONSUMES_CROSS_PARALLEL_UNSAFE` — producer/consumer in different branches of the same `parallel`, or
  consumer outside a parallel whose producer is in a branch not guaranteed to run (error; v2 may relax).
  Must classify the **data edge** `consumes.node`, not just structural edges (consensus m5).
- `CONSUMES_AS_DUP` — two refs on one node share the same `as` key (error — silent clobber otherwise,
  consensus m1).
- `PRODUCES_NAME_DUP` — two nodes share a `produces.name`. **Warning** (consensus A4): the grammar keys by
  `node`, so a duplicate name can't cause a real resolution bug; it's a clarity guard.

Dominance + the runtime `revo.InputMissing` guard are **complementary** (consensus M2/Q2): dominance is
static ("never produced"); the runtime guard catches dynamic staleness/skip that dominance can't see.
Diff classifier: `produces`/`consumes` change = breaking (explicit `DIFF_NODE_TOPOLOGY_CHANGED`).

## 8. Storage details

- `run_outputs` added to `control-plane/bootstrap.config.json` (draft scope; snake_case columns; `payload`
  a serialized-JSON string like `events.payload`; registered in `tables.ts` runtime allow-list +
  `json-fields.ts`).
- **Migration must CREATE the table, not just patch it** (consensus M1/A8): `applyAdditiveSchemaMigration`
  currently `getTableSchema`-then-`continue`s on a missing table → it only adds columns to existing tables.
  Add a create-if-absent branch (reuse the bootstrap `createTable(id, schema)` call) so upgraded
  control-planes gain `run_outputs`. Test BOTH the fresh-bootstrap and the upgrade path.
- **Payload size cap + by-reference spill** (consensus m3): cap inline `payload` (mirror the 4 000-char
  attempt cap / 0015's Temporal 50MB reference); oversized content spills to `payload_ref` (the
  run-artifacts FS / a ref), not inline. Reuse the existing `redactSecrets`/`redactEventPayload` redactor —
  no new policy (Q5).
- Deterministic row id `out_${fnv1a64Hex(runId|nodeId|ordinal)}` keeps writes idempotent on replay
  (ROW_CONFLICT no-op, matching `append-event.ts`). Reads (`latest`/`all`) are bounded (loops capped) and
  computed client-side; done inside the memoized hydration step (§6).

## 9. Code & diff — git, not Revisium

The developer's output is **code in the run's git branch** (worktree commits / diff), never copied into
Revisium. A downstream node that needs it gets a small **pointer** output (`{branch, baseSha, headSha,
prUrl?}`), not content. Reviewers read the diff from git (which already works — why code-review functions
and plan-review didn't).

## 10. Delivery phases

| Phase | Scope | Type |
|---|---|---|
| 1 | pipeline-core: `produces`/`consumes` types; §7 validation incl. real **dominator** computation + **freshness** (SCC/back-edge) + `CONSUMES_AS_DUP`; kit fixtures; **SM unit tests**. `interpret.ts` UNCHANGED. | pure |
| 2 | `run_outputs` table + **create-missing-table migration** + data-access (write/read latest/all/for-run) + tests (fresh + upgrade paths) | code |
| 3 | adapter: **`effectOrdinalByNode` + workflow-local output accumulator**; resolve consumes from the accumulator + hydrate; stepKey `${nodeId}#${ordinal}` (**fixes the latent 0015 bug**); persist produces to Revisium (redact + cap); `revo.InputMissing` terminal + event; runner `## Inputs`; **e2e** incl. **rework paths** (plan rework → reviewer sees the NEW plan; capped dev rework → distinct per-iteration outputs), latest/all, missing→errored | code + e2e |
| 4 | default `feature-development`: analyst `produces:plan`; planReviewer/developer/reworkDeveloper `consumes`; **add `planReviewRouter` + capped `reworkAnalyst` loop**; reviewer/developer prompts use the input; e2e on the seeded playbook incl. plan-rework | data + e2e |
| 5 | polish: `cancel` resolves pending inbox rows; (optional, data-only) analyst/reviewer model-profile tuning | misc |

Then: cherry-pick to `release/0.1.x` → release-train `alpha-bump` → new alpha.

## 11. Open questions — RESOLVED by consensus

1. **Storage shape** → **one table, JSON `payload`**, PLUS a size cap + by-reference spill now (not v2).
2. **Dominance strictness** → **error for required + keep the runtime guard** (complementary, not
   redundant); reject a consuming **entry** node.
3. **Hydration format** → **inline `## Inputs` markdown**, but resolution is a **memoized DBOS step**.
4. **ordinal semantics** → per-node monotonic execution ordinal, **adapter-owned** (workflow-local
   accumulator, replay-deterministic), folded into `stepKey` (§4.1). NOT row-counted, NOT core `RunState` —
   `interpret.ts` stays pure. The single most important revision (3-way consensus).
5. **Redaction** → **reuse existing `redactSecrets`/`redactEventPayload` as-is** + add the size cap.

## 12. Consensus review log (analyst + claude + codex — all three: NEEDS-REVISION, convergent)

- **B1/B2/B3 (BLOCKER)** non-deterministic `seq` + stepKey-reuse collapsing loop history → §4.1 (core
  ordinal). **B2 also fixes a latent 0015 bug** (attempts/events collide across loop iterations).
- **M1 (MAJOR)** migration can't create a new table → §8 (create-if-absent + upgrade-path test).
- **M2 (MAJOR)** dominance ≠ reachability, and is necessary-not-sufficient → §7 (real dominator tree;
  entry-can't-consume; runtime guard complementary).
- **M3 (MAJOR)** `revo.InputMissing` collapses to abort with no catch → §6 (terminal-by-construction +
  dedicated event).
- **M4 (MAJOR)** `iteration:'all'`/reads non-deterministic on replay → §6 (memoized resolution step).
- **m1** `CONSUMES_AS_DUP`; **m3** payload cap + spill; **A4** `PRODUCES_NAME_DUP` → warning; **A7**
  `resultSchema` is a shape-check stub (known limitation); **m6/analyst** e2e MUST cover rework paths.
- **codex confirmed all of the above (independent, NEEDS-REVISION)** and sharpened two: the ordinal is
  **adapter-owned** (workflow-local accumulator, replay-safe) NOT core — keeps `interpret.ts` pure (#3);
  hydrate from the **workflow-local accumulator**, not live Revisium reads (#4); plus the
  **`CONSUMES_STALE_RISK`** freshness rule + `staleOk` (#5). All three reviewers converged.

Implementation brief (analyst, agent a24b2d5d24c427926) captured for phase execution.
