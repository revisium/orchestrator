# Resources, workspaces, and effects v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** repository service, workspace/resource manager, filesystem artifact store
- **Source files:** `src/worker/git-worktree-manager.ts`, `src/runners/worktree.service.ts`,
  `src/control-plane/resolve-cwd.ts`, `src/run/run-outputs.ts`
- **Related ADRs:** [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md),
  [ADR-0005](../adr/0005-versioned-playbook-storage-and-revo-materialization.md)
- **Related specs:** [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [script-runtime-v1.spec.md](./script-runtime-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [revo-playbook-materialization-v1.spec.md](./revo-playbook-materialization-v1.spec.md),
  [storage-database-layout-v1.spec.md](./storage-database-layout-v1.spec.md)

## Scope

This spec defines repository snapshots, workspace plans, resource identities, filesystem/worktree capabilities, and
allocate, reuse, retain, release, dirty, failure, and recovery semantics.

It does not define pipeline routing, script behavior, artifact-family schemas, or playbook materialization content.
Scripts request resource capabilities; the resource manager owns lifecycle and paths.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, REQUIRED, and OPTIONAL are to be interpreted as described in
RFC 2119 and BCP 14.

## Current Contract

The shipped worktree manager derives one path from the run id, fetches a named base branch, and executes
`git worktree add -B <branch> <path> origin/<base>`. If that path is already a worktree, it is reused without
checking a persisted repository snapshot or workspace-plan digest. Dependency provisioning attempts a frozen
`pnpm install` and can fall back to a base-checkout `node_modules` symlink.

Release refuses a dirty worktree unless forced. Forced release removes the Git worktree and may recursively remove the
directory. The current runtime has no explicit `RepositorySnapshot`, `WorkspacePlan`, resource lease,
retention decision, or recoverable lifecycle record.

## Draft Target Contract

### Repository snapshot

```ts
type RepositorySnapshot = {
  schemaVersion: 'repository-snapshot/v1';
  repositoryId: string;
  canonicalRemote: string;
  objectFormat: 'sha1' | 'sha256';
  commit: string;
  tree: string;
  requestedRef?: string;
  resolvedAt: string;
  submodules: Array<{
    path: string;
    repositoryId: string;
    commit: string;
  }>;
  digest: string;
};
```

`commit` is the immutable execution base. `requestedRef` is provenance only. Runtime MUST NOT
re-resolve `requestedRef` during replay or recovery. The snapshot digest MUST cover repository identity,
object format, commit, tree, and submodule commits.

Route planning MUST resolve every repository used by the graph to a commit before creating an execution plan. Missing
objects MUST fail planning or trigger an explicit fetch authorized by the route. A moving branch name MUST NOT be the
execution identity.

### Workspace plan

```ts
type WorkspacePlan = {
  schemaVersion: 'workspace-plan/v1';
  workspacePlanId: string;
  digest: string;
  runId: string;
  resources: WorkspaceResource[];
  retention: {
    onSuccess: 'release' | 'retain';
    onFailure: 'retain' | 'release-if-clean';
    onCancel: 'retain' | 'release-if-clean';
  };
};

type WorkspaceResource = {
  resourceId: string;
  repositorySnapshotDigest: string;
  kind: 'git-worktree' | 'read-only-checkout' | 'directory';
  logicalName: string;
  branch?: string;
  access: 'read' | 'write';
  isolation: 'run' | 'node';
  dependencyMode: 'none' | 'locked-install' | 'shared-read-only-cache';
  capabilities: WorkspaceCapability[];
};

type WorkspaceCapability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'git.read'
  | 'git.index.write'
  | 'git.refs.write'
  | 'process.exec';
```

`workspacePlanId` and each `resourceId` MUST be stable for the run. The plan digest MUST cover all
resource identities, repository snapshot digests, branches, access, isolation, dependency modes, capabilities, and
retention rules.

Physical paths are runtime allocations. They MUST NOT be used as resource identities.

### Resource record

Prisma runtime storage MAY project resource state:

```ts
type WorkspaceResourceRecord = {
  resourceId: string;
  workspacePlanId: string;
  runId: string;
  state:
    | 'planned'
    | 'allocating'
    | 'ready'
    | 'retained'
    | 'releasing'
    | 'released'
    | 'failed';
  allocationGeneration: number;
  physicalPathRef?: string;
  repositorySnapshotDigest: string;
  observedHead?: string;
  dirtyState: 'unknown' | 'clean' | 'dirty';
  leaseOwner?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
};
```

This record is mutable runtime state and MUST live in Revo Prisma or an equivalent runtime projection. It MUST NOT be
committed as versioned Revisium meaning. DBOS owns durable lifecycle progress and retry/wait checkpoints; it does not
own repository content.

### Allocate

Allocation MUST:

1. load the pinned workspace plan and repository snapshot;
2. claim the stable resource id and allocation generation idempotently;
3. choose a path under the configured resource root;
4. verify path containment and reject symlink escapes;
5. ensure the pinned commit object is available;
6. create the declared checkout/worktree at the pinned commit;
7. create or validate the declared branch without moving an unrelated branch;
8. apply only the declared dependency mode;
9. verify capabilities and record `ready`.

Allocation MUST NOT fetch a mutable branch and substitute its new head for the pinned commit. A fetch used to obtain
the pinned object MUST be recorded as a bounded read effect.

### Reuse

An existing allocation MAY be reused only when all of these match:

- resource id and workspace-plan digest;
- repository snapshot digest and object format;
- allocation generation accepted by the recovery record;
- physical path marker and repository identity;
- branch, access mode, isolation mode, and capabilities;
- dependency mode.

A writable resource MUST also have the expected recorded HEAD. Dirty state MAY be reused only when it belongs to the
same run/resource generation and the recovery path explicitly retains it. A foreign or unproven dirty directory MUST
NOT be adopted automatically.

If a candidate fails reuse validation, the manager MUST retain it for inspection or quarantine it. It MUST NOT delete
or overwrite it to make allocation succeed.

### Retain and release

Retention preserves the workspace and records why it remains:

```ts
type RetentionReason =
  | 'dirty'
  | 'run_failed'
  | 'run_cancelled'
  | 'human_requested'
  | 'release_failed'
  | 'recovery_pending';
```

A dirty writable workspace MUST be retained unless a separately authorized destructive action identifies the exact
resource and expected state. Ordinary release MUST NOT force-delete it.

Release MUST:

1. transition `ready` or `retained` to `releasing` idempotently;
2. verify resource identity, marker, repository snapshot, and current dirty state;
3. apply the pinned retention policy;
4. detach the Git worktree when applicable;
5. remove only the validated allocation path;
6. prune resource-manager-owned metadata;
7. record `released`.

An absent path with a matching previously released record is idempotent success. An absent path without such evidence
is a typed inconsistency, not silent success.

### Recovery

Recovery MUST load the pinned workspace plan and resource records. It MUST NOT scan the filesystem to discover a
workspace by convention. It MAY recreate a missing clean workspace at the same repository snapshot with a new
allocation generation. It MUST retain and surface an unexpected dirty or identity-mismatched workspace.

A recovered script invocation receives the same logical resource id even when the physical path changes.

## Effect Capabilities

The resource manager exposes capability-scoped operations:

| Capability | Allowed behavior |
| --- | --- |
| `repository.snapshot.read` | Read repository identity and pinned commit/tree metadata. |
| `workspace.allocate` | Allocate or idempotently reuse one planned resource. |
| `workspace.inspect` | Read identity, HEAD, status, and dirty state. |
| `workspace.retain` | Record retention without deleting content. |
| `workspace.release` | Release one exact resource under its retention rules. |
| `filesystem.read` | Read beneath the validated resource root. |
| `filesystem.write` | Write beneath one writable resource root. |

Scripts MUST use these capabilities through
[script-runtime-v1.spec.md](./script-runtime-v1.spec.md). A generic script MUST NOT construct a worktree path, run
recursive deletion, or broaden its filesystem root.

## Artifact and Storage Boundary

Git owns source history, commits, branches, and diffs. The filesystem or a content-addressed blob store owns large
files, logs, patches, and archives. Revo Prisma owns mutable artifact/resource index rows and typed references for a
run. Embedded Revisium owns versioned meaning, not run workspaces or large blobs. DBOS owns lifecycle progress, not
artifact bytes.

Source, full diffs, and large blobs MUST NOT be copied into `ExecutionPlan`, pipeline reducer state, inbox
rows, or versioned knowledge rows. Producers MUST emit typed artifact references defined by
[run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md). An external reference MUST include enough immutable identity to
detect moved or replaced content.

## Security

- Resource roots MUST be configured outside repository-controlled input.
- All paths MUST be normalized and containment-checked before filesystem access.
- Symlink traversal outside the resource root MUST fail.
- Repository remotes and Git config MUST be treated as untrusted input.
- Credentials MUST be provided through pinned secret bindings and MUST NOT be written into remotes, markers, logs, or
  artifact metadata.
- Process execution MUST use an allowlisted binary/capability contract and structured argv.
- Release MUST verify exact identity before deletion.
- Destructive force release requires a separate human-approved action and is outside ordinary lifecycle behavior.

## Failure Model

Required failure classes:

| Code | Meaning |
| --- | --- |
| `repository_snapshot_missing` | The pinned commit/tree is unavailable. |
| `repository_identity_mismatch` | The checkout remote/object identity differs from the plan. |
| `workspace_allocation_failed` | A planned resource could not be created. |
| `workspace_identity_mismatch` | An existing path does not match the resource record. |
| `workspace_dirty` | Release or unsafe reuse encountered unapproved changes. |
| `workspace_path_escape` | A path or symlink escapes the resource root. |
| `workspace_capability_denied` | The caller requested an undeclared capability. |
| `workspace_release_failed` | Detach or removal failed after retention checks. |
| `workspace_recovery_inconsistent` | Durable state and physical state cannot be reconciled safely. |

Failures MUST record the resource id and safe evidence. They MUST NOT include credentials or unrestricted local paths
in public surfaces.

## Validation and Tests

Required coverage:

- repository snapshots pin commits and remain unchanged when branch heads move;
- snapshot and workspace-plan digests are canonical and change on execution-affecting edits;
- allocate creates the exact pinned commit and rejects unavailable or substituted commits;
- concurrent duplicate allocation converges on one logical resource;
- reuse accepts only matching identity, generation, snapshot, branch, capabilities, and dependency mode;
- foreign or unproven dirty workspaces are retained and never adopted or deleted;
- clean release is idempotent and dirty release retains the resource;
- path traversal and symlink escape fixtures fail before filesystem mutation;
- recovery recreates a missing clean allocation without scanning for alternatives;
- recovery surfaces mismatched durable/physical state;
- capability adapters prevent writes from read-only resources;
- source, diffs, and large blobs remain in Git/filesystem stores while runtime rows carry typed references.

## Compatibility

This is a direct-cutover contract for internal alpha runs. The target manager MUST NOT fall back to path-by-run-id
discovery, live base-branch resolution, unverified worktree reuse, or forced dirty deletion. Current worktrees MAY be
retained for manual inspection, but they are not automatically adopted into a v1 workspace plan.

## Open Questions

- Which Prisma models project workspace leases and allocation generations?
- Which content-addressed store is the default for non-Git large artifacts?
- Which dependency cache mechanisms can prove read-only sharing across isolated workspaces?

These questions keep this spec Draft.

## Changelog

- 2026-07-11: Initial Draft contract for pinned repositories, explicit workspace plans, and safe resource lifecycle.
