# Script runtime v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** script registry/compiler, effect shell, Revo runtime
- **Source files:** `src/pipeline/data-driven-task.workflow.ts`, `src/runners/integrator.ts`,
  `src/poller/pr-readiness-core.ts`, `src/worker/git-worktree-manager.ts`
- **Related ADRs:** [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md),
  [ADR-0005](../adr/0005-versioned-playbook-storage-and-revo-materialization.md)
- **Related specs:** [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md),
  [human-gates-v1.spec.md](./human-gates-v1.spec.md)

## Scope

This spec defines the trusted script/effect definition, registration, invocation, result, failure, permission,
redaction, event, timeout, retry, and idempotency contracts.

It does not define graph routing, human-gate semantics, workspace lifecycle, artifact-family schemas, or runner
protocols. A script is one bounded operation inside the effect shell. The pure pipeline reducer remains the only
algorithmic routing authority.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, REQUIRED, and OPTIONAL are to be interpreted as described in
RFC 2119 and BCP 14.

## Current Contract

The shipped runtime represents a script node with a `scriptRef` and resolves it from an in-process
`Map<string, SystemScriptHandler>`. The handler result is `ok`, `blocked`, or `failed`.
The DBOS adapter records the result and feeds only the outcome/verdict back to `pipeline-core`.

The current registry does not expose stable behavior versions, input/output schema digests, effect classes, declared
permissions, resource requirements, implementation digests, or per-definition retry/idempotency policy.

Current operations are also too broad for the target contract:

- `pollPr` performs repeated waits, reads readiness, and can mutate a draft PR to ready-for-review;
- the integrator combines Git inspection, commit/push, PR discovery/creation/update, and issue-link behavior;
- `confirmMerge` combines readiness checks, draft mutation, and merge;
- worktree allocate/reuse/release behavior is invoked like an ordinary script even though it is a resource lifecycle.

These are shipped facts, not the target operation boundaries.

## Draft Target Contract

### Definition

```ts
type ScriptClass = 'pure' | 'read' | 'write' | 'resource';

type ScriptSchemaRef = {
  id: string;
  version: string;
  digest: string;
};

type ScriptDefinition = {
  id: string;
  behaviorVersion: string;
  implementationDigest: string;
  class: ScriptClass;
  inputSchema: ScriptSchemaRef;
  outputSchema: ScriptSchemaRef;
  permissions: PermissionRequirement[];
  resources: ResourceRequirement[];
  timeout: {
    wallClockMs: number;
  };
  retry: {
    maxAttempts: number;
    retryableErrors: string[];
    backoff: 'none' | 'fixed' | 'exponential';
    backoffMs?: number;
  };
  idempotency: {
    mode: 'not-required' | 'required';
    keyFields: string[];
    duplicateResult: 'return-recorded' | 'reject';
  };
  redactionPolicyId: string;
  eventPolicyId: string;
};

type PermissionRequirement = {
  capability: string;
  access: 'read' | 'write' | 'admin';
  scopeFrom: string;
};

type ResourceRequirement = {
  kind: 'repository' | 'workspace' | 'filesystem' | 'github' | 'network';
  binding: string;
  access: 'read' | 'write' | 'allocate' | 'release';
};
```

`id` identifies the operation. `behaviorVersion` identifies its observable contract.
`implementationDigest` identifies the trusted installed implementation. Changing input interpretation,
output shape, external mutation, permission requirements, idempotency behavior, or error classification MUST create a
new behavior version.

`pure` scripts MUST NOT read clocks, randomness, process environment, filesystem, network, databases, or
mutable registries. `read` scripts MAY observe bound external state but MUST NOT mutate it. `write`
scripts MAY mutate only declared bindings. `resource` is reserved for calls into the resource manager; the
resource manager owns lifecycle semantics.

Custom script implementations are trusted install-time code. Arbitrary untrusted runtime snippets are outside v1.

### Registration and pinning

The installer/compiler MUST validate each definition and register one implementation for each
`(id, behaviorVersion, implementationDigest)` tuple. Duplicate tuples with different bytes MUST be rejected.

Route planning MUST resolve every graph `scriptRef` to an installed definition and pin its fields into the
[execution plan](./execution-plan-v1.spec.md). Execution and recovery MUST use the pinned definition. They MUST NOT
look up the latest registry entry.

The runtime MAY use a code registry to locate trusted bytes by implementation digest. A digest mismatch MUST fail
before invoking the implementation.

### Invocation

```ts
type ScriptInvocation = {
  invocationId: string;
  runId: string;
  nodeId: string;
  ordinal: number;
  executionPlanDigest: string;
  script: {
    id: string;
    behaviorVersion: string;
    implementationDigest: string;
  };
  idempotencyKey: string;
  input: unknown;
  resourceBindings: Record<string, string>;
  secretBindingIds: string[];
};
```

Before invocation, the effect shell MUST:

1. validate the definition against the execution-plan pin;
2. validate input against the pinned input schema;
3. authorize every permission against the plan;
4. resolve only the declared resource and secret bindings;
5. claim or read the idempotency record;
6. emit a standardized start event.

The implementation receives capability-scoped adapters rather than ambient filesystem, network, GitHub, or secret
access. It MUST NOT receive mutable route, profile, registry, or workflow-cursor handles.

### Result and errors

```ts
type ScriptResult =
  | {
      outcome: 'succeeded';
      output: unknown;
      externalRevision?: string;
    }
  | {
      outcome: 'blocked';
      error: ScriptError;
      output?: unknown;
    }
  | {
      outcome: 'failed';
      error: ScriptError;
      output?: unknown;
    };

type ScriptError = {
  code: string;
  category:
    | 'validation'
    | 'permission'
    | 'resource'
    | 'conflict'
    | 'transient'
    | 'external'
    | 'implementation';
  retryable: boolean;
  safeMessage: string;
  detailsRef?: string;
};
```

The effect shell MUST validate successful output against the pinned output schema before recording success. It MUST
redact all inline output and errors before persistence or event emission. Detailed raw provider output MAY be stored
only in an access-controlled external reference allowed by the redaction policy.

The recorded result, including the external revision when present, is the deterministic input to the next reducer
step. The external operation itself is not deterministic.

### Routing and gate authority

A script MUST NOT:

- select the next node;
- advance or mutate the workflow cursor;
- open, resolve, skip, or invalidate a human gate;
- change iteration or budget policy;
- add permissions, resources, or secret bindings;
- invoke another script as hidden orchestration;
- convert its error into a graph destination.

A script returns a typed result. `pipeline-core` applies graph-declared success, catch, and failure edges.
When human attention is required, the graph routes the recorded result to a declared human gate.

### Timeout, retry, and idempotency

The effect shell MUST enforce the pinned wall-clock timeout. A timeout result MUST be recorded with a stable error
code.

Retries MUST be driven by the pinned retry policy and error classification. Retry scheduling belongs to DBOS/effect
shell orchestration, not to a script implementation. A script implementation MUST NOT sleep or poll across attempts.

Every `write` and `resource` definition MUST use `idempotency.mode = 'required'`. A duplicate
invocation with the same key MUST return the recorded result or reject according to the pinned policy. A retry MUST
keep the logical idempotency key while receiving a distinct physical attempt id.

### Standard events

Each invocation MUST produce secret-redacted events with stable fields:

| Event | Required fields |
| --- | --- |
| `script_started` | run id, node id, ordinal, script id/version, invocation id |
| `script_succeeded` | invocation id, output artifact ref, external revision when present |
| `script_blocked` | invocation id, safe error code/category, details ref when present |
| `script_failed` | invocation id, safe error code/category, retryable flag |
| `script_retry_scheduled` | invocation id, next attempt, delay, triggering error code |

Provider command lines, environment variables, tokens, and raw secret-bearing output MUST NOT be event fields.

## Required Operation Boundaries

The target built-in registry MUST separate observation, mutation, and lifecycle. Exact installed ids remain an
authoring-schema decision, but the following bounded behaviors are REQUIRED:

| Current broad behavior | Required target operations |
| --- | --- |
| `pollPr` loops, reads, and marks ready | one short PR-readiness snapshot read; graph-owned wait/recheck; a separate explicit ready-for-review write |
| integrator commit/push/PR flow | separate Git status/snapshot, commit, push, PR lookup, draft-PR create, and PR metadata update writes |
| `confirmMerge` readiness plus merge | a readiness snapshot read followed, only after a fresh approval, by one merge write |
| thread response flow | separate review-thread read/classification inputs and bounded reply/resolve writes |
| worktree create/release | resource-manager allocate/reuse/release operations owned by the workspace spec |

The PR-readiness snapshot MUST perform one bounded observation and return provider state with a revision such as PR
head SHA plus observed-at metadata. It MUST NOT sleep, self-requeue, mark a PR ready, or merge. The executable graph
owns wait nodes, caps, rechecks, and recovery gates.

Ready-for-review is a visible external mutation. It MUST be a distinct `write` operation with its own
permission, idempotency key, result, and recovery path. A benign already-ready response MAY be normalized to
idempotent success.

Git and GitHub operations MUST use the pinned repository snapshot, workspace identity, expected branch/base, and
expected external revision. A write MUST fail with a conflict when its expected revision no longer matches.

## Resource Boundary

Workspace allocation, reuse, retention, release, dirty-state handling, and recovery are owned by
[resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md). Script definitions may request a
resource capability, but they MUST NOT derive worktree paths, delete dirty directories, or silently allocate a
replacement workspace.

Source files, diffs, and large blobs remain in Git or filesystem-backed artifact storage. Script results carry typed
references owned by [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md).

## Security

- Definitions MUST declare least-privilege permissions and resource bindings.
- Network access MUST be host-allowlisted by the resolved permission policy.
- Write operations MUST pin the target repository/account and expected external revision.
- Secret values MUST be injected only into the scoped adapter that needs them.
- Script input, result, errors, events, and idempotency records MUST pass the pinned redaction policy.
- An implementation digest MUST be verified before every first invocation after process start.
- Runtime-loaded arbitrary code, source-checkout scripts, and PATH-discovered script implementations MUST NOT be
  execution sources.

## Failure Model

Required failure classes:

| Code | Meaning |
| --- | --- |
| `script_definition_missing` | No pinned installed definition is available. |
| `script_digest_mismatch` | Trusted implementation bytes differ from the plan pin. |
| `script_input_invalid` | Input fails the pinned schema. |
| `script_output_invalid` | Output fails the pinned schema. |
| `script_permission_denied` | A required permission is absent or too broad. |
| `script_resource_unavailable` | A declared resource binding cannot be resolved. |
| `script_conflict` | Expected repository or external revision changed. |
| `script_timed_out` | The pinned wall-clock limit elapsed. |
| `script_idempotency_conflict` | A key is reused with non-equivalent input. |

The effect shell MUST preserve the code and safe evidence in the typed result. It MUST NOT collapse every failure to
one unstructured `ScriptFailed` string.

## Validation and Tests

Required coverage:

- definition schema rejects missing versions, digests, schemas, permissions, timeout, retry, redaction, and events;
- route planning rejects unresolved or digest-mismatched script references;
- input and output schemas are enforced around the implementation;
- pure scripts fail if they request external capabilities;
- read scripts cannot obtain write adapters;
- write/resource scripts require idempotency and return recorded results on duplicate replay;
- timeout and retry behavior uses the pinned policy and stable error classes;
- script results never choose graph destinations or create inbox rows;
- readiness snapshot performs one read and no sleep or mutation;
- ready-for-review is a separate idempotent write;
- Git and GitHub operations reject moved expected revisions;
- every event and persisted error passes redaction fixtures;
- recovery succeeds after the mutable script registry changes because the plan pin remains available.

## Compatibility

This redesign uses direct cutover for new internal-alpha runs. The target registry MUST NOT wrap the monolithic
integrator or polling loop as compatibility aliases. It MUST NOT fall back to current unversioned handlers or infer
definitions from handler names. Historical current-run events remain readable as audit evidence.

## Open Questions

- What authoring-schema version and package paths declare script definitions and implementations?
- Which built-in operations are allowed to use host-native code instead of package-shipped code while retaining a
  verifiable implementation digest?
- Which error vocabulary is shared across Git, GitHub, filesystem, and future network adapters?

These questions keep this spec Draft.

## Changelog

- 2026-07-11: Initial Draft contract for versioned, capability-scoped, bounded scripts and external effects.
