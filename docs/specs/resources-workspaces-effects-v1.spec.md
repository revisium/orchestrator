# Resources, workspaces, and effects v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo runtime, repository service, workspace lifecycle, filesystem artifact store
- **Source files:** `src/run-resources/**`, `src/workspaces/**`, `src/run/create-run.ts`,
  `src/runners/worktree.service.ts`, `src/runners/integrator-branch-naming.ts`, `prisma/schema.prisma`
- **Related ADRs:** [ADR-0010](../adr/0010-run-resources-and-workspace-planning.md),
  [ADR-0004](../adr/0004-runner-execution-contract.md),
  [ADR-0006](../adr/0006-run-profiles-and-provider-neutral-pipelines.md),
  [ADR-0008](../adr/0008-revo-projects-and-versioned-knowledge.md)
- **Related specs:** [execution plan v1](./execution-plan-v1.spec.md),
  [pipeline state machine v1](./pipeline-state-machine-v1.spec.md),
  [run profiles v1](./run-profiles-v1.spec.md),
  [runner manifest v1](./runner-manifest-v1.spec.md),
  [script runtime v1](./script-runtime-v1.spec.md),
  [run dataflow v1](./run-dataflow-v1.spec.md),
  [playbook materialization v1](./revo-playbook-materialization-v1.spec.md),
  [storage and database layout v1](./storage-database-layout-v1.spec.md)

## Scope

This spec defines portable pipeline resource declarations, node access/capture requirements, run launch resource
bindings, resolved repository and workspace plans, scratch and Git-worktree lifecycle, effect-capability boundaries,
validation, and replay rules.

It does not define artifact payloads, gate transitions, script handlers, runner selection, repository CRUD APIs,
cross-repository transactions, fragments, or a provider-neutral delivery facade. Artifact schemas remain owned by
[run dataflow v1](./run-dataflow-v1.spec.md); gate behavior remains owned by
[human gates v1](./human-gates-v1.spec.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are interpreted as in RFC 2119 / BCP 14.

## Current Contract

The shipped runtime requires a non-empty `repo` at run creation and copies it into legacy run/task fields. It has no
first-class repository-free launch. The workflow infers whether it needs a live worktree from concrete runner and
script ids, worktree preparation derives a branch at execution time, and `script:cleanupWorktree` is a graph node.
Run profiles expand one GitHub alias across a hardcoded list of PR-lifecycle node ids.

`TaskRun.routeDecision` currently pins pipeline/profile/template provenance. ADR-0004's draft runner contract adds
runner snapshots to that route decision. Neither current shape is a complete resource/workspace/effect execution plan.

The target below is not shipped. V1 is an atomic replacement: no legacy `repo` alias, dual route/execution input,
fallback cwd, cleanup script, or historical-run migration is retained.

## Target Contract

### Pipeline declarations

`Template` gains portable resource and workspace intent:

```ts
type Template = {
  // existing pipeline-state-machine-v1 fields
  resources?: Record<ResourceName, PipelineResourceDecl>;
  workspace: PipelineWorkspacePolicy;
  nodes: Record<string, Node>;
};

type ResourceName = string;

type PipelineResourceDecl = {
  kind: 'repository';
  cardinality: 'one';
  required: boolean;
};

type PipelineWorkspacePolicy =
  | { isolation: 'scratch'; retention: RetentionPolicy }
  | {
      isolation: 'resource';
      resource: ResourceName;
      mutability: 'read-only' | 'mutable';
      identity: { template: string };
      retention: RetentionPolicy;
    };

type RetentionPolicy = {
  onSuccess: 'release' | 'retain';
  onFailure: 'release' | 'retain';
  onCancel: 'release' | 'retain';
  onBlocked: 'release' | 'retain';
};
```

Rules:

- resource names MUST match `^[a-z][a-z0-9-]{0,62}$` and be unique in one template;
- `resources` absent or empty is valid;
- a resource workspace MUST reference one declared required repository resource;
- repository-free pipelines MUST use `isolation: 'scratch'`;
- `identity.template` supports only `{runId}`, `{taskId}`, and `{resource}` placeholders in V1;
- the portable template does not contain a local path, remote URL, Git ref, branch, provider account, or token;
- `retention` is explicit. The bundled feature-development target uses `release` on success/cancel and `retain` on
  failure/blocked so recoverable dirty evidence is not destroyed before operator action.

V1 cardinality is one value per resource name and a launchable V1 pipeline may declare at most one repository resource.
The names/record shape avoids a positional `repo` contract and leaves room for a later multi-resource schema, but V1
does not define secondary workspace roots or cross-repository coordination.

### Node requirements

Agent and script nodes gain the same declarative requirement shape:

```ts
type NodeRequirements = {
  resources?: Record<ResourceName, {
    access: 'read' | 'write' | 'publish' | 'admin';
    captures?: CaptureKind[];
  }>;
};

type CaptureKind =
  | 'workspaceChange'
  | 'gitChange'
  | 'githubPullRequest'
  | 'githubReadiness'
  | 'approvalSubject';
```

Access is ordered: `read < write < publish < admin`. A node receives only its declared resource handles. A capture is
desired output behavior, not runner ability. The adapter MUST NOT derive access or captures from a runner id, script
id, role id, or node id.

Artifact payload types and capture provenance are defined in run-dataflow-v1. This spec owns only the declarations and
their resolution into the execution plan.

### Launch resource bindings

Run creation supplies bindings separately from the portable pipeline:

```ts
type RunResourceBindings = Record<ResourceName, RepositoryLaunchBinding>;

type RepositoryLaunchBinding = {
  repositoryId: string;
  revision?: string;
  credentialAliases?: {
    git?: string;
    github?: string;
  };
};
```

`repositoryId` resolves a `RevoRepository`. `revision` is an optional user-requested base selector; the compiler must
resolve it to an immutable commit id before enqueue. Credential values are aliases. Secrets, tokens, cookies, private
keys, and resolved session material MUST be rejected from launch data.

The launch MUST provide exactly the required names and no undeclared names. Optional resources are reserved for a
future schema version; V1 templates use `required: true` for declared resources.

### Resolved resource and workspace plans

This spec owns the resource and workspace types embedded by
[execution-plan-v1](./execution-plan-v1.spec.md):

```ts
type ResolvedResourcePlan = {
  kind: 'repository';
  repositoryId: string;
  projectId: string;
  displayName: string;
  snapshot: GitRepositorySnapshot;
};

type GitRepositorySnapshot = {
  provider: 'git';
  remoteUrl: string; // canonical, credential-free URL
  remoteIdentity: string; // canonical host/repository identity, without user-info or credentials
  github?: {
    owner: string;
    repository: string;
  };
  baseRef: string;
  baseCommit: string;
  defaultBranch: string;
};

type ResolvedWorkspacePlan = ScratchWorkspacePlan | GitWorktreePlan;

type ScratchWorkspacePlan = {
  provider: 'scratch';
  workspaceId: string;
  retention: RetentionPolicy;
};

type GitWorktreePlan = {
  provider: 'git-worktree';
  workspaceId: string;
  resource: ResourceName;
  repositoryId: string;
  baseCommit: string;
  branch: string;
  mutability: 'read-only' | 'mutable';
  retention: RetentionPolicy;
};
```

Repository URLs MUST be canonicalized without user-info or embedded credentials. The compiler rejects credentialized
URLs rather than persisting them and uses credential aliases for authenticated access. `remoteIdentity` is derived
from the canonical URL as a credential-free host/repository identity; it MUST NOT include user-info, a token, an SSH
account, or an email address. Absolute paths are private allocation facts keyed by `workspaceId`; they are not resource
identity and MUST NOT appear in a plan, public API, output, or event.

`github` is an optional explicit provider coordinate, not a generic delivery abstraction. The compiler populates it
only when the canonical remote is a validated GitHub repository and the graph contains a GitHub operation for that
resource. Such an operation requires the coordinate and a pinned `github` credential alias; it MUST NOT parse
owner/repository from a mutable remote at execution time. A Git-only or repository-free pipeline omits it.

### Workspace and branch identity

For a mutable Git workspace, the compiler renders `identity.template`, sanitizes it to Git ref rules, and pins the
result before workspace preparation. V1 rules:

- the rendered branch is deterministic for the same `(template, runId, taskId, resource)`;
- it MUST start with `revo/` for the bundled policy;
- it MUST NOT contain credential, title, prompt, or model-generated text;
- first compilation rejects any pre-existing local or remote branch at the rendered identity with
  `revo.BranchCollision`;
- recovery reuses the pinned branch and MUST NOT rerender it.

The bundled policy uses `revo/{taskId}-{runId}` with bounded normalized identifiers. Exact truncation and hash-suffix
rules are compiler-versioned and covered by golden tests. Execution-plan-v1 owns compilation, canonical hashing,
persistence, and the rule that branch identity is resolved before workspace preparation.

### Lifecycle state machine

Workspace lifecycle is outside pipeline graph topology:

```text
planned -> preparing -> ready -> releasing -> released
              |          |          |  \-> retained (dirty or policy)
              |          |          \-> release_failed -> releasing | retained
              |          \-> retained (terminal policy)
              \-> prepare_failed -> preparing | retained

planned | preparing --cancel--> releasing | retained
```

Rules:

- preparation is idempotent by `(runId, workspaceId, executionPlanHash)`;
- lifecycle uses a single-writer lock for every `(runId, workspaceId)` transition and records its fencing token;
- lifecycle owns a durable allocation record containing `runId`, `workspaceId`, `executionPlanHash`, provider,
  absolute path under the trusted Revo data root, state, fencing token, and timestamps;
- scratch preparation first creates an empty directory with no inherited repository or process-cwd content;
- Git-worktree preparation verifies the pinned repository identity and base commit before creation;
- after allocation, preparation materializes the Revo-owned `.revo/**` bundle from the immutable playbook/route pin as
  required by revo-playbook-materialization-v1; `ready` is impossible until that verification succeeds;
- runner launch receives the allocation's resolved path as cwd, never host cwd; system scripts receive bounded
  resource clients and never the raw path;
- release runs after terminal success, cancel, failure, and blocked according to the corresponding retention field;
- release is idempotent and checks workspace identity before deletion;
- a dirty workspace scheduled for release transitions to `retained` plus an actionable lifecycle event; it is never
  force-deleted;
- a parked human gate is not terminal and does not release the workspace;
- cancellation during `planned` or `preparing` stops further preparation and applies `onCancel`; any partial allocation
  is released or retained through the same fenced lifecycle rather than deleted ad hoc;
- `prepare_failed` blocks runner/script dispatch, emits actionable evidence, and permits only fenced idempotent retry or
  operator-selected retention/cancellation; it does not silently mark a run successful;
- `release_failed` retains ownership of the allocation and permits fenced retry or operator-selected `retained`; it
  never reports `released` until identity-checked cleanup succeeds;
- host restart reconstructs the next lifecycle action from the persisted plan, durable run status, and allocation
  record for every nonterminal state; it re-materializes/verifies `.revo/**` from the immutable pin when needed;
- graph nodes cannot invoke preparation or release.

Lifecycle emits `workspace.preparing`, `workspace.ready`, `workspace.retained`, `workspace.releasing`,
`workspace.released`, `workspace.prepare_failed`, and `workspace.release_failed` events with run/workspace/resource ids
and redacted reasons. Events and API/MCP/GraphQL projections expose `workspaceId`, provider, resource, and state, never
the allocation's absolute path.

`workspace.retained` additionally carries a closed `cause` enum:
`policy-success | policy-failure | policy-cancel | policy-blocked | dirty | prepare-failed | release-failed`. Free-form
provider/filesystem evidence remains redacted and is not used as the cause discriminator.

### Replay and recovery

Execution, resume, and recovery MUST consume the persisted `ExecutionPlanV1`. They MUST NOT:

- re-read playbook/profile HEAD;
- re-resolve a repository row or default branch;
- rerender a branch;
- expand account aliases by node id;
- re-resolve runner abilities or script manifests from mutable data;
- infer workspace need or capture from concrete ids;
- substitute host cwd;
- expose or accept an arbitrary workspace path.

The host necessarily resolves trusted runner strategies and script handlers from startup registries. It MUST require
the exact ids/digests pinned by the plan. Missing or mismatched code blocks recovery before a new side effect and emits
`revo.ExecutionDependencyUnavailable`.

### Effect capability boundary

Resources grant bounded capabilities; they do not execute product operations. At plan compilation, the effective
capability set for a node is the intersection of:

- the pipeline node's declared resource access and captures;
- the resolved resource/workspace plan;
- the selected runner manifest or pinned script manifest maximum;
- the pinned credential aliases required by that operation.

The generic adapter may construct only the clients allowed by that intersection. Script-runtime-v1 owns effect
declarations, operation invocation, retries, idempotency, and result validation. This spec owns repository and
workspace identity, access order, allocation, fencing, retention, and release. Worktree preparation/release therefore
cannot be registered as ordinary scripts, and no script may derive a path or silently allocate another workspace.

Source history, full diffs, large files, logs, and archives remain in Git or filesystem/content-addressed storage.
Execution plans and Prisma lifecycle rows contain identities and bounded metadata only. Produced values use the typed
artifact references owned by run-dataflow-v1; they do not copy large content into the reducer, inbox rows, or versioned
knowledge.

## Validation

Static template validation adds:

- `RESOURCE_NAME_INVALID`;
- `RESOURCE_REF_UNRESOLVED`;
- `RESOURCE_BINDING_EXTRA`;
- `RESOURCE_BINDING_MISSING`;
- `RESOURCE_COUNT_UNSUPPORTED`;
- `WORKSPACE_POLICY_INVALID`;
- `SCRATCH_WITH_RESOURCES_INVALID`;
- `RESOURCE_ACCESS_INVALID`;
- `CAPTURE_REQUIRES_ACCESS`.

Plan compilation additionally fails on unresolved repositories/revisions, inactive projects, duplicate remote
identity where ambiguous, unsafe workspace roots, branch collisions, missing credential aliases, unsupported runner
ability, missing script definitions, schema/digest mismatch, a GitHub operation without a validated `github`
coordinate, or any secret-shaped credential value.

Required automated proof:

- no DBOS enqueue or side effect after any compile diagnostic;
- repository-free scratch isolation and zero Git/GitHub calls;
- mutable Git plan pins base commit and branch before preparation;
- arbitrary valid node/runner/script ids work through declarations;
- access/capture violations fail before handler/runner dispatch;
- registry, repository, profile, and playbook mutation after enqueue does not change recovery;
- exact handler/runner dependency mismatch blocks rather than falls back;
- success/cancel/failure lifecycle behavior, dirty retention, and idempotent recovery;
- blocked retention, cancel-during-prepare, prepare/release failure retry, and restart from every lifecycle state;
- `.revo/**` materialization and re-materialization use only the immutable route/playbook pin;
- plan, artifact, event, error, and public projection fixtures contain no absolute workspace path;
- no `cleanupWorktree` graph node in the target bundled pipeline.

Test ownership follows pipeline-test-coverage-v1: execution-plan tests own compiler/hash decisions; resource/workspace
unit tests own branch, lifecycle, fencing, and capability-intersection decisions; static policy owns declaration and
forbidden-cleanup graph shape; declarative DSL scenarios own workspace paths, gates, outputs, and Git/GitHub
call/no-call behavior; full integration remains limited to representative GitHub-first and scratch-run proofs.

## Failure Model

| Condition | Required result |
| --- | --- |
| Resource root is absent, outside trusted configuration, or unsafe | preparation fails before directory mutation |
| Derived path escapes the trusted root or crosses a symlink | `prepare_failed`; no adoption or deletion |
| Pinned repository object is unavailable | bounded exact-object fetch or `prepare_failed`; never substitute current branch head |
| Existing allocation identity differs from plan/allocation record | retain evidence and fail closed |
| Existing Git worktree is dirty or has unexpected branch/HEAD/common directory | retain; never reset or force-delete |
| Concurrent lifecycle transition has a stale fencing token | reject the stale writer |
| Materialized `.revo/**` verification fails | `prepare_failed`; runner/script dispatch remains forbidden |
| Release identity check fails | `release_failed` or `retained`; never report `released` |
| Host restarts in a nonterminal state | resume one fenced action from plan plus allocation record |

## Security

- Resource roots come from trusted host startup configuration, never pipeline, profile, launch, repository, or prompt
  data.
- Every derived allocation/cache path is normalized and containment-checked beneath its configured root before
  filesystem access; symlink traversal outside that root fails closed.
- Scratch and Git providers write an ownership marker bound to `(runId, workspaceId, executionPlanHash)` and verify it
  together with the allocation fencing token before reuse or deletion.
- Repository remotes, Git config, checkout contents, and provider responses are untrusted input.
- Credentials are resolved only through pinned aliases and MUST NOT be written into remotes, config, markers, events,
  errors, or artifacts.
- Git execution uses structured argv through the bounded adapter. Workspace lifecycle accepts no caller-authored shell
  command or process environment.
- Release removes only one exact identity-checked Revo-owned allocation. Destructive force release is outside ordinary
  lifecycle and outside this milestone.

## Compatibility

This is a direct alpha replacement. There are no aliases for `repo`, no legacy route-only execution input, no
cleanup-script compatibility node, no fallback worktree inference, and no historical-run migration. A plan with an
unknown `schemaVersion` or `compilerVersion` fails closed under execution-plan-v1. Existing runs keep their persisted
resource and workspace decisions.

## Open Implementation-shape Questions

These questions do not reopen the architecture above:

- whether query-oriented repository/resource audit rows are worth normalizing beside the canonical JSON plan;
- which operator command expires or removes a retained dirty workspace after evidence is preserved;
- how a later schema should represent several workspace roots and cross-resource coordination; V1 rejects more than
  one repository resource and never promises atomic cross-repository effects.

## Examples

Repository-free pipeline excerpt:

```json
{
  "specVersion": "pipeline/v1",
  "pipelineId": "analysis-only",
  "workspace": {
    "isolation": "scratch",
    "retention": {
      "onSuccess": "release",
      "onFailure": "retain",
      "onCancel": "release",
      "onBlocked": "retain"
    }
  },
  "resources": {},
  "nodes": {
    "analyze": { "kind": "agent", "role": "analyst", "next": "done" },
    "done": { "kind": "terminal", "status": "succeeded" }
  }
}
```

Git pipeline excerpt:

```json
{
  "resources": {
    "source": { "kind": "repository", "cardinality": "one", "required": true }
  },
  "workspace": {
    "isolation": "resource",
    "resource": "source",
    "mutability": "mutable",
    "identity": { "template": "revo/{taskId}-{runId}" },
    "retention": {
      "onSuccess": "release",
      "onFailure": "retain",
      "onCancel": "release",
      "onBlocked": "retain"
    }
  },
  "nodes": {
    "implement": {
      "kind": "agent",
      "role": "developer",
      "requirements": {
        "resources": {
          "source": { "access": "write", "captures": ["workspaceChange", "gitChange"] }
        }
      },
      "next": "review"
    }
  }
}
```

## Changelog

- 2026-07-12: Consolidated ADR-0010's concrete resource declarations, resolved plans, isolated lifecycle, capability
  intersection, and direct-cutover rules into the canonical resource/workspace owner created by PR #320.
- 2026-07-11: Initial Draft contract for pinned repositories, explicit workspace plans, and safe resource lifecycle.
