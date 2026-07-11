# Run dataflow v1 spec

- **Status:** Accepted
- **Version:** v1
- **Source files:** `src/pipeline-core/types.ts`, `src/pipeline-core/validate-dataflow.ts`,
  `src/pipeline/data-driven-task.workflow.ts`, `src/run/run-outputs.ts`, `src/run/prisma-runtime-data-access.ts`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md).

## Scope

Run dataflow is the canonical owner of typed artifact families and reference modes. It defines how step outputs move
from producer nodes to later consumer nodes without widening the state-machine routing signal. It covers produced
artifacts, prompt hydration, validation, storage, and replay safety.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Layers

| Layer | Carries | Owner |
| --- | --- | --- |
| Routing signal | `outcome`, domain `verdict`, counters, join arrivals | DBOS progress through `RunState` and `LastResult` |
| Step output | plans, review findings, integration reports, PR feedback summaries | Prisma `RunOutput` plus adapter accumulator |
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
- Missing required input MUST be a fail-loud runtime error.
- `staleOk` only suppresses a freshness warning; it MUST NOT change hydration behavior.

## Runtime Contract

Before an effect node runs, the adapter resolves `consumes` from the workflow-local output accumulator, not from a
live storage query. This keeps DBOS replay deterministic.

Resolution rules:

- `latest`: highest ordinal output for the producer node.
- `all`: all outputs for the producer node, ordered by ordinal.
- number: exact 1-based ordinal.
- optional missing input: omitted.
- required missing input: emit a dedicated failure event and block/fail the run with `revo.InputMissing`.

The adapter injects hydrated inputs into the runner prompt under a stable `## Inputs (from previous steps)` section.

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

Ordinals MUST NOT be computed by counting live Prisma rows or by time.

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

- Prisma runtime scope; rows MUST NOT be committed as versioned meaning.
- Append-only: rows MUST NOT be updated or deleted.
- One row per node execution that declares `produces`.
- For retried runner attempts, `attempt_id` and over-cap `payload_ref` point at the winning physical attempt id,
  not the logical `stepKey`.
- Latest output is `max(ordinal)` per `(run_id, node_id)`.
- Payload is serialized JSON, secret-redacted, and size-capped.
- Oversized content spills by reference in `payload_ref`.
- Code and diffs MUST NOT be copied into runtime storage; downstream nodes receive pointers such as branch/head/PR
  metadata.

## Draft Target: Typed Artifact Families

The shipped `produces.name` plus optional `resultSchema` contract remains the current behavior. The
target compiler replaces the single Git-shaped catch-all convention with explicit, versioned artifact families.

### Family and schema identity

```ts
type ArtifactSchemaRef = {
  family: string;
  schemaId: string;
  version: string;
  digest: string;
};

type ArtifactEnvelope = {
  artifactId: string;
  schema: ArtifactSchemaRef;
  value: ArtifactValueRef;
  provenance: {
    runId: string;
    nodeId: string;
    ordinal: number;
    attemptId?: string;
    executionPlanDigest: string;
    producedAt: string;
  };
};

type ArtifactValueRef =
  | {
      mode: 'inline';
      mediaType: 'application/json';
      value: unknown;
      contentDigest: string;
    }
  | {
      mode: 'content-addressed';
      storeId: string;
      contentDigest: string;
      mediaType: string;
      bytes: number;
    }
  | {
      mode: 'external';
      store: 'git' | 'filesystem' | 'github' | 'revisium';
      locator: Record<string, string>;
      immutableRevision: string;
      contentDigest?: string;
    };
```

The installed playbook owns artifact schema documents. The execution plan pins every schema id, version, and digest
that its graph can produce or consume. [execution-plan-v1.spec.md](./execution-plan-v1.spec.md) owns that pin; it MUST
NOT redefine family fields or reference semantics.

Initial family vocabulary:

| Family | Contract purpose |
| --- | --- |
| `plan` | Requirements, route, or implementation plan intended for review. |
| `review` | Independent review verdict and findings over a pinned subject. |
| `change` | Repository/workspace change identity and typed source/diff references. |
| `pr-readiness` | One bounded GitHub readiness snapshot and observed external revision. |
| `verification` | Local or remote gate results and evidence references. |
| `gate-resolution` | Human outcome plus the pinned approval subject and resolution provenance. |
| `knowledge-proposal` | Proposal document/revision metadata for ADR or KB acceptance flow. |
| `resource` | Repository snapshot or workspace resource identity and lifecycle evidence. |

Artifact family ids are extensible installed data. A family id MUST resolve to one pinned schema version before a run
starts. Producers and consumers MUST NOT infer a schema from an artifact name.

### Reference modes

`inline` is allowed only for secret-redacted JSON within the pinned payload limit.
`content-addressed` is REQUIRED for immutable content whose bytes are stored by Revo and exceed that limit.
`external` is REQUIRED when Git, filesystem, GitHub, or Revisium remains the authoritative store.

An external reference MUST include an immutable revision. A mutable path, branch name, PR number, or document id by
itself is not an artifact identity. Git references use the repository snapshot plus object/commit identity.
Filesystem references use a resource id plus content digest. GitHub references use repository identity plus an
observed revision such as head SHA. Revisium references use project/document identity plus accepted revision id.

Prisma `RunOutput` rows store the envelope and bounded inline value or reference. They MUST NOT store full
source trees, diffs, repository blobs, large logs, or duplicate accepted ADR/KB bodies. The authoritative bytes remain
in Git, the validated filesystem/content-addressed store, GitHub, or Revisium.

### Target change artifact

The target `change` family separates repository/workspace identity from source and diff content:

```ts
type ChangeArtifact = {
  repositorySnapshotDigest: string;
  workspaceResourceId: string;
  baseCommit: string;
  headCommit: string;
  branch?: string;
  sourceRef: ArtifactValueRef;
  diffRef?: ArtifactValueRef;
  pullRequestRef?: ArtifactValueRef;
};
```

`sourceRef` and `diffRef` MUST use external or content-addressed modes. They MUST NOT embed source
or diff text inline. Workspace identity and lifecycle semantics are owned by
[resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md).

### Target validation

The compiler and runtime MUST validate:

- every producer and consumer family resolves to one execution-plan schema pin;
- producer output validates against the pinned family schema;
- consumer aliases do not change the artifact family or schema version;
- inline payloads satisfy size and redaction policy;
- content-addressed bytes match their digest;
- external references contain store-specific immutable identity;
- recovery uses the recorded envelope and does not re-query a mutable latest artifact;
- an unavailable reference fails with a typed artifact error before worker invocation.

### `schema:change` Produced Artifact

The following shape documents shipped current behavior. It is not the target cross-family artifact model above.

After a live developer change producer succeeds, the adapter records the agent's output with an attached `change`
pointer:

```ts
type ProducedChangeArtifact = {
  branch: string;
  headSha: string;
  issueRef?: { repo: string; number: number; url: string };
  worktreePath?: string;
  artifactRef?: string;
  prNumber?: number;
};
```

The adapter captures this pointer before reviewer or integrator handoff. Integrator
script nodes consume the latest relevant change pointer and push that exact `headSha`. When a produced change is
available, they MUST NOT inspect the shared/base checkout. A "nothing to integrate" no-op is valid only when the
produced `headSha` already equals the open PR head.

Issue-bound runs carry their canonical issue traceability metadata through `issueRef` and the linkage policy through
`issueAction`. The propagation rules:

- `issueRef` and `issueAction` are copied from the run context into produced change artifacts and integrator inputs,
  so branch, commit, PR title/body, readiness checks, and merge confirmation use the same issue contract.
- `issueAction` is `close`, `refs`, or `none`; issue-bound runs default to `close`.
- Copying `issueRef` MUST preserve the produced artifact's authoritative `branch`.
- Branch names may contain `issue-<number>` for issue-bound work.
- For `close` and `refs`, commits and PR titles MAY include a non-closing `#<number>` same-repo reference or
  `owner/repo#<number>` cross-repo reference.
- For `close`, PR bodies MUST contain one closing reference for the canonical issue and merge confirmation MUST
  verify GitHub reports the issue in `closingIssuesReferences`.
- For `refs`, PR bodies and titles preserve non-closing references without adding closing keywords.
- For `none`, publication MUST NOT inject issue tokens into commit messages, PR titles, or PR bodies.
- The host does not call issue-close endpoints directly.

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

- 2026-07-11: Made this spec the artifact-family owner and added the Draft inline, content-addressed, and external
  reference contract while preserving `schema:change` as current shipped behavior.
- 2026-06-29: Normative-language / canon-discipline pass; no contract change.
- 2026-06-27: Added issueRef propagation to produced change artifacts and integrator handoff.
- 2026-06-27: Clarified that produced run outputs for retried runner nodes reference the winning physical attempt.
- 2026-06-26: Initial spec extracted from former plan 0016 and `pipeline-core` dataflow types.
