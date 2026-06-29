# Pipeline state machine v1 spec

- **Status:** Accepted.
- **Source files:** `src/pipeline-core/**`, `src/pipeline/data-driven-task.workflow.ts`,
  `src/pipeline/data-driven-template.ts`, `control-plane/default-playbook/catalog/pipelines.json`.
- **Related ADRs:** [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md).

## Scope

This spec defines the versioned pipeline template grammar and the pure state-machine contract executed by the DBOS
adapter. It covers routing and progress decisions, not runner implementation details or UI rendering.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Invariants

- Pipelines are data: a versioned graph template stored in a `pipelines.execution_policy_json` payload.
- `pipeline-core` is pure, deterministic, and I/O-free.
- DBOS owns live progress and replay; Revisium owns meaning, projections, events, and inbox rows.
- Role and script identifiers in templates are opaque capability handles. The core MUST NOT hardcode role ids.
- A run pins the template revision at start; later HEAD edits affect only new runs.

## Template Shape

```ts
type Template = {
  specVersion: string;
  pipelineId: string;
  title?: string;
  entry: string;
  verdicts: { domain: string[] };
  policy?: {
    conflicts: Array<[string, string]>;
    enforcement: 'strict' | 'warn';
  };
  scopes?: Record<string, { cap: number; parent: string | null }>;
  nodes: Record<string, Node>;
};
```

Each node has a stable map key id. Node ids are permanent: a removed id MUST NOT be reused for a different meaning.

## Node Kinds

The v1 node kind set is closed:

| Kind | Purpose | Exit fields | Core decision |
| --- | --- | --- | --- |
| `agent` | Invoke a role capability | `next`, optional `catch` | `invokeRole` |
| `script` | Invoke a system script capability | `next`, optional `catch` | `invokeScript` |
| `humanGate` | Suspend for human verdict | `branches`, optional `timeout` | `awaitGate` |
| `choice` | Pure guard routing | `branches` | none; routes immediately |
| `parallel` | Fork named branches | `branches[]`, `join` | `fork` |
| `join` | Converge branch arrivals | `joinMode`, optional `merge`, `next` | none; routes immediately |
| `wait` | Timed auto-resume | `duration`, `next` | `startTimer` |
| `terminal` | Finish the run | none | `complete` |

Effect nodes share:

```ts
type EffectNodeFields = {
  next: string;
  catch?: Array<{ onError: `revo.${string}`; goto: string }>;
  resultSchema?: string;
  onFailure?: 'abort' | 'route' | 'escalate';
  escalateTo?: string;
  incrementCounters?: string[];
  produces?: { name: string };
  consumes?: ConsumesRef[];
};
```

## Conditions and Branches

`Condition` is a closed tagged union. Expression strings MUST NOT be used.

```ts
type Condition =
  | { op: 'verdict.eq'; value: string }
  | { op: 'verdict.in'; value: string[] }
  | { op: 'counter.lt'; scope: string; value: number }
  | { op: 'counter.gte'; scope: string; value: number }
  | { op: 'all'; of: Condition[] }
  | { op: 'any'; of: Condition[] }
  | { op: 'not'; cond: Condition };
```

Branches are ordered, first true wins, and MUST end with exactly one default branch:

```ts
type Branch = { when: Condition; goto: string } | { default: string };
```

Core verdicts route structurally and MUST NOT appear in `verdict.*` guards. Domain verdicts are declared in
`template.verdicts.domain` and are opaque labels to the engine.

## Runner Verdict Vocabulary

For agent nodes, the DBOS adapter passes the active `template.verdicts.domain` to the runner. The runner's structured
output schema and final-result instructions must advertise only that active domain, including a JSON Schema `enum` when
the domain is known. This keeps narrow templates such as `local-change` from offering broad tokens like `clean` that the
template would reject.

The adapter still validates every agent result against `template.verdicts.domain` before routing. This validation is
defense-in-depth; it is not a substitute for giving the runner the active domain up front.

## Failure and Timeout

- Transient runner retry is a DBOS adapter concern, not a template concern. Templates MUST NOT declare retry policy;
  the adapter pins the resolved policy in the DBOS workflow input before enqueue and retries only eligible physical
  runner attempts while keeping the logical node `stepKey` unchanged.
- `humanGate.timeout` is optional. If absent, the gate can wait indefinitely.
- A gate timeout routes via `timeout.goto`; it is not matched by a verdict guard.
- Effect failure precedence:
  1. Matching `catch.onError`.
  2. `onFailure: 'abort'` completes failed.
  3. `onFailure: 'route'` requires a matching catch and is invalid otherwise.
  4. `onFailure: 'escalate'` routes to `escalateTo`.

## Fork and Join

`parallel` branches are named and enter global node ids. A branch MUST route only within itself or to the matching
join. `joinMode` is one of:

```ts
type JoinMode =
  | { kind: 'all' }
  | { kind: 'any' }
  | { kind: 'quorum'; count: number };
```

Merge reducers are `overwrite` or `appendByBranchOrder`. `lastWrite` MUST be rejected because replay order must be
deterministic.

The adapter records branch arrivals as durable facts and feeds them to the pure core as `joinArrivals`. The core
does not observe live branch races.

## Runtime State and Decisions

```ts
type RunState = {
  activeNodeIds: ReadonlySet<string>;
  scopedCounters: Readonly<Record<string, number>>;
  status: 'running' | 'awaiting_gate' | 'succeeded' | 'failed' | 'blocked';
  lastResult?: LastResult;
};

type LastResult = {
  outcome?: 'succeeded' | 'failed' | 'errored' | 'timed_out';
  verdict?: string;
  errorCode?: `revo.${string}`;
  joinArrivals?: Array<{ branchId: string; seq: number; verdict?: string }>;
};
```

`step(template, state, lastResult)` advances one observable step and returns the next state plus one decision:

- `invokeRole`
- `invokeScript`
- `awaitGate`
- `fork`
- `startTimer`
- `complete`

## Validation

`validateTemplate(template)` returns all diagnostics from the full validation pass. Diagnostic codes are a stable
public contract. Rule groups:

1. Single entry.
2. References resolve.
3. Terminal and non-terminal exit shape.
4. Condition grammar.
5. Total routing with one trailing default.
6. Reachability.
7. Failure policy well-formedness.
8. Loop cap and counter-scope well-formedness.
9. Parallel/join well-formedness.
10. Verdict vocabulary closure.
11. Conflict matrix.
12. Id/namespace hygiene.
13. Capability reference shape.
14. Dataflow produce/consume checks.

Notable diagnostic families include `LOOP_UNBOUNDED`, `VERDICT_CORE_IN_GUARD`,
`FAILURE_ROUTE_NO_CATCH`, `SCOPE_SPANS_PARALLEL`, `MERGE_LASTWRITE_REJECTED`, and the dataflow codes documented
in [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md).

## Diff Classification

`classifyTemplateDiff(old, next)` is conservative:

- Deleting a node, changing a node kind, or changing outgoing topology is breaking.
- Reusing a deleted id with incompatible meaning is invalid.
- Display name, prompt, and payload-only changes are classified safe only by an explicit allowlist entry;
  everything else defaults to breaking with a diagnostic.

v1 reports safe/breaking information but does not migrate live in-flight runs.

## Changelog

- 2026-06-29: Normative-language / canon-discipline pass; no contract change.
- 2026-06-27: Clarified that transient runner retry is implemented by the DBOS adapter around physical attempts,
  not by templates or `pipeline-core`.
- 2026-06-26: Initial spec extracted from the data-driven state-machine ADR, former plan 0015, and
  `src/pipeline-core`.
