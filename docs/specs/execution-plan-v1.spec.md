# Execution plan v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** route planner, pipeline compiler, Revo runtime
- **Source files:** `src/execution-plan/**`, `src/run-resources/canonical-json.ts`,
  `src/pipeline/route-contract.ts`, `src/task-control-plane/task-control-plane-api.service.ts`,
  `src/pipeline/pipeline.service.ts`, `src/run/create-run.ts`, `prisma/schema.prisma`
- **Related ADRs:** [ADR-0005](../adr/0005-versioned-playbook-storage-and-revo-materialization.md),
  [ADR-0006](../adr/0006-run-profiles-and-provider-neutral-pipelines.md),
  [ADR-0010](../adr/0010-run-resources-and-workspace-planning.md),
  [ADR-0011](../adr/0011-system-script-runtime-and-trusted-extensions.md)
- **Related specs:** [playbook storage v1](./playbook-storage-v1.spec.md),
  [Revo playbook materialization v1](./revo-playbook-materialization-v1.spec.md),
  [pipeline state machine v1](./pipeline-state-machine-v1.spec.md),
  [resources, workspaces, and effects v1](./resources-workspaces-effects-v1.spec.md),
  [script runtime v1](./script-runtime-v1.spec.md),
  [run dataflow v1](./run-dataflow-v1.spec.md),
  [human gates v1](./human-gates-v1.spec.md),
  [run profiles v1](./run-profiles-v1.spec.md),
  [runner manifest v1](./runner-manifest-v1.spec.md)

## Scope

This spec defines the one immutable execution input compiled before DBOS enqueue. It owns the exact plan shape,
compiler order, canonical serialization, hash, atomic persistence, enqueue fence, and recovery read boundary.

It does not redefine playbook/profile selection provenance, runner manifest fields, resource/workspace semantics,
script behavior, artifact schemas, gate transitions, or large-artifact storage. Those remain with the linked owner
specs and appear here only as resolved pinned components.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are interpreted as in RFC 2119 / BCP 14.

## Current Contract

The shipped runtime stores a partial `RouteDecision` on `TaskRun.routeDecision`, reconstructs a template during
start/resume, and enqueues `{route, template}`. Repository, workspace, branch, resource access, captures, credential
aliases, and script definitions remain unresolved or are inferred after enqueue.

The target below is not shipped. It is a direct internal-alpha replacement. There is no dual route/plan execution
source, fallback recompilation, partial-plan mode, or historical-run migration.

## Target Contract

### RouteDecision ownership

`RouteDecision` remains the sole owner of why and how route selection occurred:

- requested and selected playbook/pipeline identity;
- immutable playbook selection and content-tree pins;
- profile source, identity, version, normalized snapshot, and hashes;
- materialized template, template hash, authoring/compiler versions, and selected context pins;
- selected role/node bindings and complete runner manifest/capability snapshots;
- execution policy, iteration/budget policy, routing source, materializer version, and policy version.

Those fields remain defined by run-profiles-v1, playbook-storage-v1, revo-playbook-materialization-v1, and
runner-manifest-v1. `ExecutionPlanV1` nests that object exactly once. It MUST NOT copy playbook, pipeline, profile,
role, runner, policy, budget, or selected-context data into sibling plan fields.

The separate `policies`, `context`, `playbook`, `pipeline`, and `roles` fields from the initial Draft
execution-plan sketch are therefore not part of the concrete V1 shape. Their execution-affecting data is already
owned by `RouteDecision`; duplicating it would create conflicting replay authorities.

### ExecutionPlanV1

The compiler produces exactly:

```ts
type ExecutionPlanV1 = {
  schemaVersion: 'execution-plan/v1';
  compilerVersion: string;
  runId: string;
  taskId: string;
  task: ResolvedTaskInputV1;
  routeDecision: RouteDecision;
  resources: Record<ResourceName, ResolvedResourcePlan>;
  workspace: ResolvedWorkspacePlan;
  nodes: Record<string, ResolvedNodePlan>;
  scripts: Record<string, ScriptDefinitionPin>;
  credentials: Record<string, CredentialAliasPin>;
};

type ResolvedTaskInputV1 = {
  title: string;
  description: string;
  scope: string;
  priority: number;
  issueRef?: IssueRef;
  issueAction: 'close' | 'refs' | 'none';
};

type ResolvedNodePlan = {
  kind: Node['kind'];
  resources: Record<ResourceName, {
    access: 'read' | 'write' | 'publish' | 'admin';
    captures: CaptureKind[];
  }>;
  script?: {
    definitionId: string;
    definitionVersion: string;
    definitionDigest: string;
    inputBindings: Record<string, ScriptInputBindingV1>;
  };
};

type CredentialAliasPin = {
  resource: ResourceName;
  kind: 'git' | 'github';
  alias: string;
  source: 'launch' | 'profile' | 'host-default';
};
```

`ResolvedTaskInputV1` is the sole effect-time task metadata snapshot. The compiler copies normalized launch fields
before persistence; `RouteDecision.params` MUST exclude the reserved `title`, `description`, `scope`, `priority`,
`issueRef`, and `issueAction` keys so the same value cannot become a second execution authority. Arbitrary non-reserved
route parameters remain inside `RouteDecision`. Missing description/scope normalize to the empty string, missing
priority to the current run-contract default, and missing issue action to `close` when `issueRef` exists or `none`
otherwise.

`ResourceName`, `ResolvedResourcePlan`, `ResolvedWorkspacePlan`, and `CaptureKind` are owned by
resources-workspaces-effects-v1. `ScriptDefinitionPin` is owned by script-runtime-v1. They are embedded values, not
mutable foreign-key lookups.

Required keying:

- `scripts`: `<id>@<version>`;
- `credentials`: `<resourceName>:git` or `<resourceName>:github`;
- workspace identity: opaque `workspaceId`;
- persisted hash: `sha256:<lowercase-hex>`.

The plan contains no `executionPlanId`, `createdAt`, or self-referential digest. Runtime row identity and timestamps
live outside the canonical bytes. `TaskRun.executionPlanHash` is the digest of the entire validated plan and is
persisted atomically beside it.

Artifact-family and approval-subject schemas are pinned by the exact materialized graph and script definitions that
produce/consume them. V1 does not add a second global schema registry field beside those pins. Large content, source,
full diffs, logs, and archives remain in their canonical Git/filesystem/content-addressed stores and are referenced by
typed run-dataflow artifacts.

`ScriptInputBindingV1` is owned by pipeline-state-machine-v1. The compiler resolves every output alias and plan pointer,
pins the closed binding map on the node, and validates it against the pinned script input schema before enqueue.

### Credential alias resolution

`credentials` is keyed by resource and kind. Resolution precedence is:

1. explicit launch resource binding;
2. selected profile resource binding;
3. explicitly configured host-default alias.

Multiple aliases at one precedence, an undeclared resource, unknown kind, or missing required alias fails compilation.
The compiler pins the winning alias and source. Operation time may resolve that alias to current secret bytes but MUST
NOT choose a different account or widen scope.

Host defaults come only from validated startup configuration. Compilation MUST NOT infer identity from an active CLI
account, ambient token, last-used session, provider command output, repository URL user-info, or process environment.
Runner authentication remains runner-manifest/host behavior and is not represented as a repository credential pin.

### Branch resolution

The compiler applies the exact workspace identity rules in resources-workspaces-effects-v1 and pins the branch before
workspace preparation:

- only `{runId}`, `{taskId}`, and `{resource}` placeholders are accepted;
- rendering is deterministic for the same plan inputs;
- the bundled policy begins with `revo/`;
- credential, title, prompt, model-generated text, and ambient branch state are forbidden inputs;
- a pre-existing local or remote branch on first compilation fails with `revo.BranchCollision`;
- recovery reuses the pinned branch and never rerenders it.

Exact normalization, truncation, and hash-suffix behavior is compiler-versioned and covered by golden tests.

### Compilation order

Compilation order is normative:

| Order | Operation | Durable or external effect permitted |
| --- | --- | --- |
| 1 | Resolve playbook, pipeline, and profile | reads only |
| 2 | Materialize the template and construct `RouteDecision` | no |
| 3 | Resolve and snapshot complete runner manifests | no |
| 4 | Validate launch bindings and resolve repository snapshots | bounded reads; no mutation |
| 5 | Resolve credential aliases | alias reads only |
| 6 | Resolve workspace provider and branch plan | no allocation or branch creation |
| 7 | Resolve node grants and captures | no |
| 8 | Resolve exact script definitions, pins, and declarative input bindings | sealed-registry reads only |
| 9 | Validate the complete plan | no |
| 10 | Canonicalize and hash | no |
| 11 | Persist plan and hash atomically | Prisma write only |
| 12 | Invoke the enqueue callback with the persisted plan | only after commit |

No workspace allocation, branch creation, Git/GitHub mutation, runner process, script handler, or DBOS workflow may
start before step 11 commits.

### Canonical JSON and hash

The V1 implementation is fixed:

- `package.json` and `pnpm-lock.yaml` pin exact `canonicalize@3.0.0` with no version range;
- `src/run-resources/canonical-json.ts` is the only wrapper used by execution-plan and script-definition hashing;
- the wrapper accepts JSON values only and rejects `undefined`, sparse arrays, `bigint`, functions, symbols,
  cycles, and non-finite numbers;
- it hashes the returned canonical UTF-8 bytes with SHA-256 and adds no newline;
- invalid input fails with `PLAN_CANONICAL_JSON_INVALID` before persistence or enqueue;
- changing package, wrapper semantics, accepted values, or byte encoding requires a new `compilerVersion` and new
  golden vectors.

Exact goldens:

| Input value | Canonical UTF-8 text | SHA-256 |
| --- | --- | --- |
| `{ "b": 1, "a": 2 }` | `{"a":2,"b":1}` | `sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772` |
| `{ "z": 0, "a": { "d": 4, "c": 3 } }` | `{"a":{"c":3,"d":4},"z":0}` | `sha256:6fb42e7e8723d0e34cd882ea18891ab7e9519b0367ca272c65db9749feffc93c` |
| `[null, true, false, 0, 1.5, 1e30]` | `[null,true,false,0,1.5,1e+30]` | `sha256:8571eb0b4b00e16bf26aa3fdd4774702a58433f4ddf7ac7e89048c3107c1eafd` |

Tests also use RFC 8785 numeric and Unicode ordering vectors and prove insertion-order independence.

### Persistence and enqueue

The target row stores:

```prisma
model TaskRun {
  executionPlan     Json
  executionPlanHash String

  @@index([executionPlanHash])
}
```

The plan/hash pair is one transaction. The enqueue callback receives the exact persisted object only after commit.
Retry with the same plan/hash is idempotent. A different plan for the same run/task is a typed conflict and MUST NOT
overwrite the first plan.

Staging slices may introduce nullable inactive columns while the shipped route path remains the sole production path.
The atomic production cutover removes standalone `routeDecision`, `repos`, and `repoRef` as execution sources and
makes the target fields mandatory. Runtime code MUST NOT branch between old and new inputs.

### Recovery read boundary

Execution, replay, resume, retry, digest, inspection, and crash recovery read the persisted plan. They MUST NOT:

- re-read mutable repository, profile, playbook, role, pipeline, schema, or policy rows to reconstruct meaning;
- resolve a new source/default branch head or rerender branch identity;
- rematerialize topology from the current profile/playbook;
- discover runner/script latest versions or substitute a different digest;
- expand credentials by node id or select an ambient account;
- discover a workspace by path convention or host cwd;
- mutate or patch the plan.

External readiness/effect operations may observe current provider state when their pinned operation requires it. Their
typed output becomes durable run-dataflow input; it does not rewrite the plan.

Missing exact runner or script code fails before any new side effect with
`revo.ExecutionDependencyUnavailable`. A startup audit must detect missing recovery-eligible script pins before the
host accepts run creation or DBOS recovery.

## Validation

Compilation fails before persistence/enqueue for:

- invalid pipeline resources, workspace policy, node grants, or captures;
- unresolved/inactive repository identity or immutable revision;
- branch collision or invalid branch rendering;
- missing/ambiguous credential alias or secret-shaped input;
- incomplete route, playbook selection, profile, context, execution-policy, budget, or runner pin;
- unknown script id/version, definition digest mismatch, or schema mismatch;
- unknown plan/compiler version;
- non-JSON canonicalization input;
- any absolute workspace path, token, session, private key, cookie, or environment map.

Required automated proof:

- exact canonical strings/hashes and insertion-order independence;
- every execution-affecting change alters the hash;
- zero persistence/enqueue/runner/script/external calls after each compile diagnostic;
- zero/one repository plans and repository-free scratch plans;
- deterministic branch render and collision behavior;
- exact runner/script pins and failure after mutable registry changes;
- credential precedence, ambiguity, missing aliases, and secret exclusion;
- atomic plan/hash transaction, rollback, same-plan retry, and conflicting retry;
- enqueue only after commit and with the persisted object;
- recovery after mutable repository/profile/playbook/registry changes without recompilation;
- no path or credential in plans, errors, events, artifacts, or public projections.

## Failure Model

| Condition | Required result |
| --- | --- |
| Invalid resource/template/plan | closed compile diagnostic; no plan or enqueue |
| Repository missing/inactive | no fallback identity |
| Revision unresolved | no mutable ref in plan |
| Branch collision | `revo.BranchCollision`; no branch mutation |
| Credential alias missing/ambiguous | no ambient fallback |
| Runner/script exact dependency missing | `revo.ExecutionDependencyUnavailable` |
| Canonicalization invalid | `PLAN_CANONICAL_JSON_INVALID`; no persistence |
| Prisma transaction failure | no partial plan/hash; full retry |
| Same plan already persisted | return exact persisted plan; enqueue at most once |
| Different plan already persisted | typed conflict; retain original |
| Enqueue callback failure | retain plan; retry reloads same plan/hash |
| Host restart after persistence | resume from persisted plan; no recompilation |
| Plan bytes/hash mismatch | fail closed before dispatch |

These are planner/runtime failures, not agent reasoning failures.

## Security

- Plan creation enforces least privilege across node grant, resource plan, runner ability, script maximum, and
  credential alias.
- Secret aliases and resolver provenance may be pinned; secret values never enter the plan.
- Repository URLs are canonical and credential-free.
- Absolute paths remain only in private fenced workspace allocations.
- Prompt-backed workers receive only selected materialized documents and the bounded plan projection required by their
  node.
- Logs, events, errors, artifacts, and API projections must redact credentials and host-private paths.
- A worker or script result cannot mutate the plan, advance the workflow cursor, resolve a gate, or add access.

## Compatibility

This is a direct internal-alpha cutover. New V1 runs do not execute from legacy partial route objects, positional
repository strings, mutable registry reads, fallback profiles, source-checkout discovery, or host cwd. There is no
historical-run migration or in-flight V1 compatibility adapter. Old local data is reset.

Unknown `schemaVersion` or `compilerVersion` fails closed. A behavior-changing compiler or canonicalization rule
requires a new compiler version; existing runs retain their persisted bytes and exact executable pins.

## Open Implementation-shape Questions

These questions do not reopen the fixed contract:

- whether query-oriented audit projections should normalize selected plan fields beside canonical JSON;
- how a later schema represents several repositories and workspace roots;
- which operator surface reports or expires plans whose exact trusted executable package is no longer retained.

## Changelog

- 2026-07-12: Resolved the PR #320 Draft into ADR-0010's concrete V1 plan: one nested `RouteDecision`, exact
  resource/workspace/node/script/credential pins, fixed RFC 8785 implementation, atomic persistence/enqueue, and no
  parallel policy/context/repository authorities.
- 2026-07-11: Initial Draft contract for fully resolved route pins and recovery-safe execution input.
