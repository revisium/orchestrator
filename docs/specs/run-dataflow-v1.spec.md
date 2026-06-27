# Run dataflow v1 spec

- **Status:** Accepted.
- **Source files:** `src/pipeline-core/types.ts`, `src/pipeline-core/validate-dataflow.ts`,
  `src/pipeline/data-driven-task.workflow.ts`, `src/run/run-outputs.ts`, `src/control-plane/**`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md).

## Scope

Run dataflow defines how step outputs move from producer nodes to later consumer nodes without widening the
state-machine routing signal. It covers produced artifacts, prompt hydration, validation, storage, and replay
safety.

## Layers

| Layer | Carries | Owner |
| --- | --- | --- |
| Routing signal | `outcome`, domain `verdict`, counters, join arrivals | DBOS progress through `RunState` and `LastResult` |
| Step output | plans, review findings, integration reports, PR feedback summaries | Revisium `run_outputs` plus adapter accumulator |
| Code/diff | source changes, branches, PRs | Git worktree and remote |

The pure core validates `produces` and `consumes`; the DBOS adapter resolves and persists content.

## Template Declarations

Effect nodes can produce one named output:

```ts
type ProducesDecl = { name: string };
```

Effect nodes can consume outputs from earlier nodes:

```ts
type ConsumesRef = {
  node: string;
  as: string;
  iteration?: 'latest' | 'all' | number;
  optional?: boolean;
  staleOk?: boolean;
};
```

Defaults:

- `iteration` defaults to `latest`.
- `optional` defaults to `false`.
- Missing required input is a fail-loud runtime error.
- `staleOk` only suppresses a freshness warning; it does not change hydration behavior.

## Runtime Contract

Before an effect node runs, the adapter resolves `consumes` from the workflow-local output accumulator, not from a
live Revisium query. This keeps DBOS replay deterministic.

Resolution rules:

- `latest`: highest ordinal output for the producer node.
- `all`: all outputs for the producer node, ordered by ordinal.
- number: exact 1-based ordinal.
- optional missing input: omitted.
- required missing input: emit a dedicated failure event and block/fail the run with `revo.InputMissing`.

Hydrated inputs are injected into the runner prompt under a stable `## Inputs (from previous steps)` section.

After an effect node succeeds, the adapter shape-checks the result against the node's `resultSchema`, redacts
secrets, enforces the payload cap/spill policy, appends a `run_outputs` row if `produces` is declared, and feeds
only routing fields back to the core.

## Ordinals and Replay

The adapter maintains a workflow-local per-node execution ordinal. The ordinal increments each time the adapter
executes an effect for that node and is rebuilt deterministically on replay.

Uses:

- `stepKey = <nodeId>#<ordinal>` for distinct attempts/events across loop iterations.
- `run_outputs.ordinal`.
- deterministic output row id based on `(runId, nodeId, ordinal)`.

Do not compute ordinals by counting live Revisium rows or by time.

## `run_outputs`

Logical row shape:

```text
run_outputs {
  id
  run_id
  node_id
  ordinal
  name
  schema_ref
  payload
  payload_ref
  attempt_id
  produced_at
}
```

Rules:

- Runtime/draft scope; rows are never committed as versioned meaning.
- Append-only; do not update or delete rows.
- One row per node execution that declares `produces`.
- For retried runner attempts, `attempt_id` and over-cap `payload_ref` point at the winning physical attempt id,
  not the logical `stepKey`.
- Latest output is `max(ordinal)` per `(run_id, node_id)`.
- Payload is serialized JSON, secret-redacted, and size-capped.
- Oversized content spills by reference in `payload_ref`.
- Code and diffs are not copied into Revisium; downstream nodes receive pointers such as branch/head/PR metadata.

## Static Validation

`validateTemplate` includes dataflow diagnostics:

- `CONSUMES_NODE_UNRESOLVED`: producer node id does not exist.
- `CONSUMES_PRODUCER_MISSING`: referenced node cannot produce output.
- `CONSUMES_NOT_DOMINATED`: required producer does not dominate the consumer. Warning when optional.
- `CONSUMES_STALE_RISK`: consumer can be re-entered without producer and uses `latest` without `staleOk`.
- `CONSUMES_CROSS_PARALLEL_UNSAFE`: unsafe consume across parallel branches.
- `CONSUMES_AS_DUP`: duplicate `as` key within a consumer.
- `PRODUCES_NAME_DUP`: duplicate output names across nodes. Warning; node id remains the key.
- `GATE_REF_UNRESOLVED`: gate artifact/verdict ref points at an unknown node.
- `GATE_ARTIFACT_NO_PRODUCES`: gate artifact ref points at a node with no produced artifact.

Dominance checks and runtime `revo.InputMissing` are complementary. Dominance proves possible production; runtime
guards still catch dynamic skips and stale paths.

## Changelog

- 2026-06-27: Clarified that produced run outputs for retried runner nodes reference the winning physical attempt.
- 2026-06-26: Initial spec extracted from former plan 0016 and `pipeline-core` dataflow types.
