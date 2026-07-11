# Execution plan v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** route planner, playbook installer/compiler, Revo runtime
- **Source files:** `src/pipeline/route-contract.ts`, `src/pipeline/pipeline.service.ts`,
  `src/control-plane/run-profiles.ts`, `src/run/create-run.ts`, `prisma/schema.prisma`
- **Related ADRs:** [ADR-0005](../adr/0005-versioned-playbook-storage-and-revo-materialization.md),
  [ADR-0006](../adr/0006-run-profiles-and-provider-neutral-pipelines.md)
- **Related specs:** [playbook-storage-v1.spec.md](./playbook-storage-v1.spec.md),
  [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [script-runtime-v1.spec.md](./script-runtime-v1.spec.md),
  [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [human-gates-v1.spec.md](./human-gates-v1.spec.md),
  [runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md)

## Scope

This spec defines the immutable, fully resolved execution contract produced after route planning and consumed by one
run. It owns execution-input pinning, plan identity, installation and route validation, and the recovery read
boundary.

It does not own pipeline graph semantics, script behavior, artifact-family schemas, approval freshness semantics,
workspace lifecycle, or runner protocol details. Those concerns remain with the related specs above.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, REQUIRED, and OPTIONAL are to be interpreted as described in
RFC 2119 and BCP 14.

## Current Contract

The shipped runtime stores a `RouteDecision` JSON object on Prisma `TaskRun.routeDecision` and passes that
object as a DBOS workflow argument. Stored and inline run profiles can pin a materialized template, template hash,
profile snapshot, profile hash, materializer version, policy version, and resolved role launch bindings.

The current route object is not a complete execution plan. It does not pin an immutable installed playbook version,
script-definition behavior versions and digests, typed artifact schema versions, generic approval-subject schema
version, repository snapshots, workspace/resource plans, budget policy, or secret-binding references. Current
execution still resolves scripts through an in-process registry and uses live worktree and Git/GitHub state inside
effects.

## Draft Target Contract

### Identity and immutability

An `ExecutionPlan` is created once for a run:

```ts
type Digest = string; // sha256:<lowercase hex>

type PinnedSchemaRef = {
  id: string;
  version: string;
  digest: Digest;
};

type RepositorySnapshotRef = {
  repositoryId: string;
  snapshotDigest: Digest;
};

type WorkspacePlanRef = {
  workspacePlanId: string;
  digest: Digest;
};

type ExecutionPlan = {
  schemaVersion: 'execution-plan/v1';
  executionPlanId: string;
  executionPlanDigest: Digest;
  createdAt: string;
  playbook: {
    playbookVersionId: string;
    snapshotHash: Digest;
    contentTreeHash: Digest;
    authoringSchemaVersion: string;
  };
  pipeline: {
    pipelineId: string;
    executableGraph: unknown;
    graphDigest: Digest;
    compilerVersion: string;
  };
  roles: ResolvedRoleBinding[];
  scripts: ResolvedScriptBinding[];
  artifactSchemas: PinnedSchemaRef[];
  approvalSubjectSchema: PinnedSchemaRef;
  policies: ResolvedPolicyPins;
  repositories: RepositorySnapshotRef[];
  resourcePlan: WorkspacePlanRef;
  context: ResolvedContextPins;
};
```

`executionPlanDigest` MUST be the SHA-256 digest of a canonical serialization of every field except
`executionPlanId`, `executionPlanDigest`, and `createdAt`. Object keys MUST be sorted. Array order MUST
remain semantic. Unknown fields MUST make validation fail until the plan schema version changes.

The plan MUST be immutable after a run is created. Display metadata and query projections MAY live outside the plan,
but they MUST NOT affect execution.

### Resolved bindings

```ts
type ResolvedRoleBinding = {
  nodeId: string;
  roleId: string;
  roleDocumentId: string;
  runnerId: string;
  runnerManifestVersion: string;
  runnerManifestDigest: Digest;
  modelProfileId: string;
  modelProfileVersion: string;
  permissionPolicyId: string;
  permissionPolicyVersion: string;
  timeoutMs: number;
  retryPolicyId: string;
  retryPolicyVersion: string;
  selectedDocumentIds: string[];
};

type ResolvedScriptBinding = {
  nodeId: string;
  scriptId: string;
  behaviorVersion: string;
  implementationDigest: Digest;
  inputSchema: PinnedSchemaRef;
  outputSchema: PinnedSchemaRef;
  permissionPolicyId: string;
  permissionPolicyVersion: string;
  resourceBindingIds: string[];
  timeoutMs: number;
  retryPolicyId: string;
  retryPolicyVersion: string;
};
```

Every executable agent and script node MUST have exactly one resolved binding. The plan MUST NOT contain unresolved
role, runner, model, permission, script, schema, retry, or resource aliases.

The script fields above pin definitions owned by
[script-runtime-v1.spec.md](./script-runtime-v1.spec.md). They do not redefine script behavior.

### Policy, budget, context, and secrets

```ts
type ResolvedPolicyPins = {
  routePolicy: PinnedSchemaRef;
  iterationCaps: Record<string, number>;
  budget: {
    tokenLimit?: number;
    reportedCostLimit?: string;
    currency?: string;
    exhaustionAction: 'needs_human' | 'stop' | 'degrade_models';
    approvedModelDowngrades: Array<{ from: string; to: string }>;
  };
};

type SecretBindingRef = {
  bindingId: string;
  provider: string;
  accountAlias: string;
  scope: string[];
  resolverVersion: string;
};

type ResolvedContextPins = {
  secretBindings: SecretBindingRef[];
  knowledgeRevisions: Array<{
    projectId: string;
    documentId: string;
    acceptedRevisionId: string;
    contentDigest: Digest;
  }>;
};
```

The plan MUST store secret references, never secret values. A secret reference MUST identify the approved provider,
account alias, scope, and resolver behavior version. Secret rotation MAY change the resolved credential bytes, but it
MUST NOT widen the pinned account or scope.

Budget exhaustion MUST follow the pinned action. `degrade_models` is valid only when the exact downgrade path
is present in `approvedModelDowngrades`.

### Repository and resource pins

`RepositorySnapshotRef` and `WorkspacePlanRef` are references to the records owned by
[resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md). The plan MUST pin at least one
repository snapshot for every repository that an executable node can read or mutate. Each resource binding used by a
script or role MUST resolve inside the pinned workspace plan.

### Artifact and approval pins

`artifactSchemas` pins the schema id, version, and digest for every artifact family that the graph can produce
or consume. Artifact family definitions and reference modes are owned by
[run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md).

`approvalSubjectSchema` pins the generic approval-subject schema used by the plan. Subject revision,
freshness, invalidation, and approval-record semantics are owned by
[human-gates-v1.spec.md](./human-gates-v1.spec.md). An execution plan MUST NOT encode domain node ids as approval
semantics.

### Recovery read boundary

Replay, resume, retry, and crash recovery MUST read execution-affecting input from the persisted plan and recorded
effect results. They MUST NOT resolve any of these from mutable state:

- source checkout HEAD or remote branch HEAD;
- the latest playbook, profile, pipeline, role, model, runner, script, or schema registry entry;
- a mutable project knowledge head;
- a newly discovered filesystem path;
- an ambient account other than the pinned secret binding.

An external effect MAY read current external state when its definition requires it. The result MUST be recorded as a
typed effect result before the pure reducer uses it. Recovery reuses the recorded result for the same idempotency key.

## Installation and Route Validation

Playbook installation MUST fail before creating a version when:

- the executable graph or a referenced document is missing;
- a role, script, schema, policy, or fragment reference does not resolve inside the package;
- a behavior-changing definition lacks a stable version and digest;
- a declared permission or resource requirement is unavailable to the installer/compiler;
- the graph fails the pipeline-core validator.

Route planning MUST fail before creating a run when:

- the requested pipeline or profile is unavailable;
- an executable node cannot be bound exactly once;
- a runner, model, permission, script, secret alias, repository, or resource requirement is unresolved;
- an artifact or approval-subject schema pin is absent;
- the resolved graph digest differs from the installed graph digest;
- a repository snapshot commit cannot be resolved;
- a budget or iteration policy is incomplete.

Plan loading during recovery MUST fail closed when the persisted bytes do not match
`executionPlanDigest` or a referenced immutable object is unavailable.

## Security

- Plan creation MUST validate that permissions are no broader than the approved route and profile.
- Secret-binding scopes MUST be least-privilege and MUST be included in the plan digest.
- Repository and workspace paths MUST be validated by the resource owner before use.
- Prompt-backed workers MUST receive only the selected documents and secret-free plan projections required for their
  node.
- Logs, events, artifacts, and validation errors MUST NOT include credential values.
- A worker result MUST NOT mutate the plan, advance the workflow cursor, resolve a gate, or add permissions.

## Failure Model

Required failure classes:

| Code | Meaning |
| --- | --- |
| `execution_plan_invalid` | Plan shape or canonical digest is invalid. |
| `execution_plan_reference_missing` | A pinned immutable object is unavailable. |
| `execution_plan_binding_unresolved` | A node, permission, secret, or resource binding is unresolved. |
| `execution_plan_schema_mismatch` | A pinned artifact, approval, runner, or script schema digest differs. |
| `repository_snapshot_unresolved` | A repository commit could not be pinned. |
| `execution_plan_recovery_violation` | Recovery attempted a forbidden mutable read. |

These are route/runtime failures. They MUST NOT be converted into agent reasoning failures.

## Validation and Tests

Required coverage:

- canonical serialization produces the same digest across repeated planning;
- changing any execution-affecting field changes the digest;
- route planning resolves every graph node and rejects missing or duplicate bindings;
- install validation rejects unresolved graph, script, schema, policy, and document references;
- route validation rejects missing repository/resource, permission, budget, or secret bindings;
- run creation stores the exact plan bytes and digest before DBOS enqueue;
- recovery succeeds after mutable playbook, profile, source HEAD, runner registry, and script registry changes;
- recovery fails when a pinned immutable object or plan byte is missing or corrupt;
- no secret value appears in plan storage, events, logs, or artifacts;
- artifact and approval pins validate against their canonical owner schemas without duplicating their semantics.

## Compatibility

This is a direct-cutover contract for the internal alpha redesign. Once execution-plan v1 becomes the run input, new
runs MUST NOT also execute from legacy partial route objects, mutable registry reads, fallback profile resolution, or
source-checkout discovery. Historical runs MAY remain readable for audit. A historical run is not replayable unless
all execution-affecting inputs can be represented as a valid immutable execution plan.

## Open Questions

- Which persisted record owns the immutable plan bytes in addition to the DBOS workflow input projection?
- Which installed authoring-schema version first requires executable graph, script, artifact-schema, and future
  fragment references?
- Which content-addressed store owns immutable plan bytes and large referenced manifests?

These questions keep this spec Draft. They MUST be resolved before implementation is described as shipped.

## Changelog

- 2026-07-11: Initial Draft contract for fully resolved route pins and recovery-safe execution input.
