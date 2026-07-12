# Pipeline state machine v1 spec

- **Status:** Accepted
- **Version:** v1
- **Source files:** `src/pipeline-core/**`, `src/pipeline/data-driven-task.workflow.ts`,
  `src/pipeline/data-driven-template.ts`, `control-plane/default-playbook/catalog/pipelines.json`.
- **Related ADRs:** [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md),
  [ADR-0010](../adr/0010-run-resources-and-workspace-planning.md),
  [ADR-0011](../adr/0011-system-script-runtime-and-trusted-extensions.md).
- **Related specs:** [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [script-runtime-v1.spec.md](./script-runtime-v1.spec.md),
  [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [human-gates-v1.spec.md](./human-gates-v1.spec.md).

## Scope

This spec is the canonical owner of the versioned pipeline graph grammar and the pure state-machine reducer contract
executed by the DBOS adapter. It covers routing and progress decisions, not route-time resolution, script behavior,
runner implementation details, storage projections, or UI rendering.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Invariants

- Pipelines are data. The shipped graph template is stored in a versioned
  `pipelines.execution_policy_json` payload.
- `pipeline-core` is pure, deterministic, and I/O-free.
- DBOS owns durable workflow progress, waits, retries, checkpoints, and replay.
- Revo Prisma owns mutable run, task, attempt, inbox, event, output, and cost rows.
- Embedded Revisium owns versioned control-plane meaning such as installed pipeline definitions and policy.
- Role and script identifiers in templates are opaque capability handles. The core MUST NOT hardcode role ids.
- The core MUST NOT resolve runners, scripts, permissions, resources, schemas, secrets, or storage rows.
- A reducer call consumes one graph, one state, and one recorded result, and emits exactly one decision.
- A run pins the effective graph before execution; later source or registry edits affect only new runs.

## Execution Boundary

### Current shipped boundary

The DBOS adapter receives the materialized template and partial route decision as workflow input. It invokes current
runner and script adapters, persists runtime facts through Prisma data access, and feeds the recorded routing fields
back to the pure reducer.

### Draft target boundary

The target adapter receives a pinned `ExecutionPlan` defined by
[execution-plan-v1.spec.md](./execution-plan-v1.spec.md). The plan resolves the executable graph and every
execution-affecting binding before the workflow starts. `pipeline-core` continues to consume only graph,
state, and recorded results. It MUST NOT read a playbook source, mutable registry, repository, filesystem, Prisma,
Revisium, DBOS internals, or network service.

Script definitions, effect classes, and execution policy are owned by
[script-runtime-v1.spec.md](./script-runtime-v1.spec.md). This spec owns only the opaque `scriptRef` in the
graph and the `invokeScript` decision.

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

### Target resource composition

Under ADR-0010, `Template` also declares portable named `resources` and one `workspace` policy, while effect nodes
declare `requirements.resources` access/capture needs. Resources-workspaces-effects-v1 owns the exact grammar.

The pure core validates names, references, and access/capture shape. It does not resolve repositories, Git worktrees,
credentials, runner abilities, or script handlers. The pre-enqueue compiler performs that resolution.

## Node Kinds

The v1 node kind set is closed:

| Kind | Purpose | Exit fields | Core decision |
| --- | --- | --- | --- |
| `agent` | Invoke a role capability | `next`, optional `catch` | `invokeRole` |
| `script` | Invoke a pinned script/effect capability | `next`, optional `catch` | `invokeScript` |
| `humanGate` | Suspend for human verdict | `branches`, optional `timeout` | `awaitGate` |
| `choice` | Pure guard routing | `branches` | none; routes immediately |
| `parallel` | Fork named branches | `branches[]`, `join` | `fork` |
| `join` | Converge branch arrivals | `joinMode`, optional `merge`, `next` | none; routes immediately |
| `wait` | Timed auto-resume | `duration`, `next` | `startTimer` |
| `terminal` | Finish the run | none | `complete` |

The target adapter MUST implement `startTimer` as one DBOS-backed durable sleep before resuming `wait.next`; returning
immediately is invalid. V1 wait durations match
`^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,3}))?S)?$`, require at least one component and a positive safe-integer
millisecond total, and fail static validation as `WAIT_DURATION_INVALID` otherwise. Unit tests inject the adapter sleep
dependency; a recovery test proves an outstanding timer survives host restart without repeating the preceding effect.

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

Target script nodes additionally declare a closed top-level input map:

```ts
type ScriptInputBindingV1 =
  | { source: 'output'; alias: string; pointer?: string; optional?: boolean }
  | { source: 'plan'; pointer: string; optional?: boolean }
  | { source: 'literal'; value: JsonValue };

type ScriptNodeV1Target = EffectNodeFields & {
  kind: 'script';
  scriptRef: { id: string; version: string };
  inputBindings: Record<string, ScriptInputBindingV1>;
};
```

`source: output` reads one already hydrated `consumes[].as` alias. The pointer base is the complete
run-dataflow-v1 `HydratedOutputV1` envelope: `/value` enters the domain payload, while `/artifactId`,
`/contentDigest`, `/schema`, and `/provenance` select host metadata. `pointer` is an RFC 6901 JSON Pointer over that
envelope; absent pointer selects the whole envelope. `source: plan` reads only the persisted, redacted execution
plan and MUST point to an existing field. `source: literal` accepts a JSON value fixed in portable pipeline data.

Bindings build only the top-level script input object. A map containing the sole reserved key `$` binds the complete
script input value; `$` cannot coexist with named fields. Bindings do not evaluate expressions, templates, conditionals,
array maps, provider calls, or arbitrary code. A binding with `optional:true` omits its target field when the alias or
pointer is absent; every other missing alias/pointer is `revo.InputMissing`. Compilation rejects an unknown alias,
invalid pointer, forbidden
secret/path-bearing plan field, duplicate target field, non-JSON literal, or binding whose statically known type cannot
satisfy the pinned input schema. Runtime resolves the pinned map generically, validates the complete result against the
pinned schema, and never branches on node or script id.

Static failures use `SCRIPT_INPUT_BINDING_INVALID` with node id, target field, source alias/pointer, and a safe reason.
Runtime absence after an optional branch/replay path uses `revo.InputMissing` before bounded-client construction.

In the ADR-0010/0011 target, agent and script nodes carry resource requirements. A script node uses the closed
`{ id: string, version: string }` reference; compilation resolves only that version and pins its definition digest.
String-only refs, implicit latest selection, ranges, and fallbacks are invalid. Worktree preparation/release is not a
node kind and MUST NOT be represented as a script.

When a script manifest declares a verdict JSON pointer, run-dataflow-v1 validates and extracts the domain verdict
generically before `choice` routing. Core routing consumes `LastResult.verdict`; it never recognizes a concrete script
or node id.

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

- Transient runner and script retry is a DBOS/effect-shell concern, not a template-grammar concern. Templates MUST
  NOT declare retry policy;
  the adapter pins the resolved policy in the DBOS workflow input before enqueue and retries only eligible physical
  attempts while keeping the logical node `stepKey` unchanged.
- `humanGate.timeout` is optional. If absent, the gate can wait indefinitely.
- A gate timeout routes via `timeout.goto`; it is not matched by a verdict guard.
- Effect failure precedence:
  1. Matching `catch.onError`.
  2. `onFailure: 'abort'` completes failed.
  3. `onFailure: 'route'` requires a matching catch and is invalid otherwise.
  4. `onFailure: 'escalate'` routes to `escalateTo`.

## Stuck Review Recovery

The bundled `feature-development` pipeline uses a reusable `codeStuckGate` with explicit outcomes:
`approve_anyway`, `rework`, and `cancel`. `approve_anyway` is a human override to the integrator, `rework` routes
through `stuckReworkDeveloper`, and `cancel` completes the run as `cancelled`. The stuck recovery loop is capped by
its own scope, and `codeReviewLoop` is a child of that scope so each human-approved stuck rework starts a fresh normal
developer/reviewer cycle series without creating a separate follow-up task.

Materialized run-profile templates must preserve the same stuck-recovery safeguards as the base
`feature-development` template.

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
  status: 'running' | 'awaiting_gate' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
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

The target adapter receives `ExecutionPlanV1`, not a template plus ambient host assumptions. `RouteDecision` remains
the selection-provenance component nested in that plan. Generic core and adapter behavior MUST NOT compare concrete
runner, script, role, resource, or node ids.

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
15. Resource/workspace declarations and node access/capture checks from resources-workspaces-effects-v1.

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

- 2026-07-12: Fixed target wait-duration grammar and DBOS-backed durable timer/recovery semantics.
- 2026-07-12: Consolidated ADR-0010/0011 resource declarations, exact script refs, lifecycle-owned workspaces, and
  id-agnostic plan-backed execution into the PR #320 target boundary.
- 2026-07-11: Corrected runtime storage ownership to Revo Prisma, made this spec the pure graph/reducer owner, and
  separated the current route input from the Draft pinned execution-plan boundary.
- 2026-07-01: Added `cancelled` terminal status and documented reusable ordinary code-stuck recovery.
- 2026-06-29: Normative-language / canon-discipline pass; no contract change.
- 2026-06-27: Clarified that transient runner retry is implemented by the DBOS adapter around physical attempts,
  not by templates or `pipeline-core`.
- 2026-06-26: Initial spec extracted from the data-driven state-machine ADR, former plan 0015, and
  `src/pipeline-core`.
