# Revo playbook materialization v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** `src/worker`, `src/runners`, `src/playbook`, Revo runtime.
- **Source files:** `src/worker/git-worktree-manager.ts`, `src/runners/worktree.service.ts`,
  `src/worker/build-context.ts`, `src/playbook/prompt-composer.ts`, `src/playbook/import-mapper.ts`.
- **Related ADRs:** [ADR-0005](../adr/0005-versioned-playbook-storage-and-revo-materialization.md).
- **Related specs:** [playbook-storage-v1.spec.md](./playbook-storage-v1.spec.md),
  [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md),
  [runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md).

## Scope

This spec defines how a pinned playbook snapshot and execution plan are materialized into a planned Revo run
workspace and how prompt-backed workers discover role, reference, stack, method, and template context from that
materialization.

This spec does not define how playbook documents are stored in Revisium. That is owned by
[playbook-storage-v1.spec.md](./playbook-storage-v1.spec.md). It also does not define provider-specific prompt or
runner output parsing.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Current Contract

The shipped worktree manager creates a git worktree, provisions dependencies, and writes a worktree marker. It does
not create `.revo/playbook` or `.revo/context`.

The shipped prompt composer reads role markdown directly from the installed playbook source during import and stores
the composed text in `roles.system_prompt`. Conditional references, shared references, stack references, templates,
and method docs are not materialized into the run worktree by runtime code.

## Target Migration

### Layout

Every run worktree that executes a prompt-backed or code-backed role MUST contain:

```text
.revo/
  playbook/
    manifest.json
    playbook.json
    catalog/
    roles/
    pipelines/
    graphs/
    scripts/
    schemas/
    references/
    stacks/
    method/
    templates/
    checklists/
  context/
    run.json
    steps/
      <nodeId>/
        selected-references.json
```

The materializer MUST write only files from the pinned `PlaybookVersion`. It MUST NOT copy from a live
`agent-playbook` checkout at worker invocation time.

### `.revo/playbook/manifest.json`

The manifest is the materialized bundle contract.

```ts
type RevoPlaybookManifest = {
  schemaVersion: 1;
  playbookVersionId: string;
  playbookId: string;
  packageName: string;
  packageVersion: string;
  snapshotHash: string;
  contentTreeHash: string;
  materializedAt: string;
  canonicalRoots: string[];
  excludedRoots: string[];
  documentCount: number;
  runtimeDocumentCount: number;
  files: Array<{
    path: string;
    documentId: string;
    kind: string;
    contentHash: string;
    bytes: number;
    runtimeIncluded: boolean;
  }>;
};
```

`files[].path` MUST be relative to `.revo/playbook`, normalized with `/`, and must not contain `..`.
`.revo/playbook/manifest.json` MUST NOT be listed in `files[]`; self-hashing would be circular.
`documentCount` is copied from `PlaybookVersion.documentCount`. `runtimeDocumentCount` MUST equal `files.length`.

There are two independent manifest version namespaces:

- source playbook manifest: `.revo/playbook/playbook.json` with `schema_version`;
- materialized bundle manifest: `.revo/playbook/manifest.json` with `schemaVersion`.

The materializer MUST validate the manifest after writing it by checking that every listed file exists and matches its
content hash. Runtime MUST also recompute `contentTreeHash` from the listed materialized files and compare it with the
value pinned in `.revo/context/run.json`. Runtime MUST fail before worker invocation when validation fails.

### `.revo/context/run.json`

`run.json` records the route-time playbook pin and worktree-local run identity.

```ts
type RevoRunContext = {
  runId: string;
  attemptId?: string;
  executionPlanHash: string;
  playbookVersionId: string;
  snapshotHash: string;
  contentTreeHash: string;
  selectedPipelineId: string;
  resource?: string;
  repositoryId?: string;
  workspaceId: string;
};
```

`run.json` is run-scoped and immutable for the workspace. It MUST be a projection of the pinned execution
plan. It MUST NOT carry a mutable source path or a single selected role because one run workspace can execute multiple
roles and concurrent nodes.

### `.revo/context/steps/<nodeId>/selected-references.json`

Each worker invocation receives a step-scoped selected-reference file. This avoids races when a multi-role or
concurrent pipeline shares one run worktree.

```ts
type RevoSelectedReferences = {
  executionPlanHash: string;
  playbookVersionId: string;
  snapshotHash: string;
  contentTreeHash: string;
  pipelineId: string;
  nodeId: string;
  roleId: string;
  workspaceId: string;
  roleDocuments: string[];
  sharedReferences: string[];
  stacks: string[];
  stackReferences: string[];
  methodDocuments: string[];
  templates: string[];
  checklists: string[];
};
```

All paths are relative to `.revo/playbook` and MUST exist in `manifest.json`. The selected set SHOULD include the role
document and role core reference. The materialized bundle MAY contain the full canonical snapshot, but the selected
list is the role's first-read contract.

The materialized selected-reference file MUST be a faithful path projection of the matching resolved role binding in
the immutable `ExecutionPlanV1`. Runtime MUST validate that `executionPlanHash`,
`playbookVersionId`, `snapshotHash`, and `contentTreeHash` match `run.json` before
invoking the worker.

Projection rules:

- `roleDocuments`: selected documents with kind `role` or `role_reference` for `roleId`;
- `sharedReferences`: selected references with scope `shared`;
- `stacks`: selected documents with kind `stack`;
- `stackReferences`: selected references with scope `stack`;
- `methodDocuments`: selected documents with kind `method`;
- `templates`: selected documents with kind `template`;
- `checklists`: selected documents with kind `checklist`.

The materializer derives paths from `PlaybookDocument.path`. A selected id that cannot be classified by document kind,
reference scope, or stack projection is a materialization error unless the route pin marks it optional.

### Prompt contract

Prompt-backed workers MUST receive an instruction equivalent to:

```text
Your playbook context is worktree-local. Read {{STEP_CONTEXT_PATH}}/selected-references.json, then load selected
documents from .revo/playbook. Do not read the source agent-playbook checkout. If a selected document is missing,
return an access/materialization failure instead of guessing.
```

The base system prompt SHOULD contain only the role dispatcher and core reference. Shared references, stack
references, method docs, and templates SHOULD be loaded from `.revo` on demand.

### Included and excluded roots

The default materialization MUST include these canonical roots when present in the pinned snapshot:

```text
playbook.json
catalog/
roles/
pipelines/
graphs/
scripts/
schemas/
references/
stacks/
method/
templates/
checklists/
```

The target materializer MUST reject undeclared catalog-addressed runtime documents outside those roots. The current
flat default playbook and `prompts/<role>.md` path remain Current Contract inputs only.

The default materialization MUST exclude:

- `.git/`
- `.github/`
- `adapters/`
- `legacy/`
- ignored local overlays
- generated caches or package manager output

### Failure classification

Materialization failures are environment/runtime failures, not role reasoning failures. Revo SHOULD classify these
separately from code verification or agent verdict failures.

Required failure classes:

| Code | Meaning |
| --- | --- |
| `playbook_snapshot_missing` | The route pin references a snapshot unavailable to the materializer. |
| `playbook_materialization_failed` | The materializer could not write the bundle. |
| `playbook_manifest_invalid` | Manifest JSON is missing, malformed, or violates schema. |
| `playbook_manifest_hash_mismatch` | A materialized file does not match the manifest hash. |
| `playbook_selected_reference_missing` | A selected reference path is not present in the manifest or filesystem. |

## Validation

Required tests:

- materializer writes the target `.revo` layout for a pinned fixture snapshot;
- `manifest.json` lists every materialized runtime file and excludes `adapters/` and `legacy/`;
- repeated materialization of the same snapshot produces identical file hashes;
- manifest validation recomputes `contentTreeHash` and compares it with the durable run pin;
- selected references resolve to manifest entries and filesystem paths;
- `run.json` matches the pinned execution plan and workspace resource;
- selected references are a faithful per-node projection of execution-plan role bindings;
- corrupting a materialized file produces `playbook_manifest_hash_mismatch`;
- deleting a selected reference produces `playbook_selected_reference_missing`;
- prompt composition includes the worktree-local `.revo` load instruction and step context path;
- a stub runner, given the composed prompt and materialized `.revo`, can open every selected role/core/shared/stack
  reference using only the worktree-local bundle.

Live provider smoke with Claude, OpenCode, Codex, GLM, or other external runners is optional and SHOULD NOT be a unit
test dependency. The 2026-07-01 manual smoke proved the access model with Codex subagents, Claude, and OpenCode. GLM
returned provider-side 529 overload and was not a materializer verdict.

## Compatibility

This redesign uses direct cutover for new internal-alpha runs. Prompt-backed workers MUST use the selected
worktree-local bundle; runtime MUST NOT fall back to `roles.system_prompt` or a live source checkout.

Existing runs without `.revo/playbook` remain readable for audit and are not replayable under this contract.
The runtime MUST NOT reconstruct missing snapshots from mutable current source.

For new runs, crash recovery MAY recreate a missing clean workspace through the resource manager and MUST
re-materialize `.revo` from the immutable execution plan before resuming worker execution.
Re-materialization MUST be idempotent for the same `executionPlanHash`, `workspaceId`,
`playbookVersionId`, and `contentTreeHash`.

## Examples

Minimal `selected-references.json` for a developer role:

```json
{
  "executionPlanHash": "sha256:plan",
  "playbookVersionId": "revisium-agent-playbook@0.1.0:sha256:abc",
  "snapshotHash": "sha256:abc",
  "contentTreeHash": "sha256:def",
  "pipelineId": "feature-development",
  "nodeId": "developer-implementation",
  "roleId": "developer",
  "workspaceId": "workspace:run-01:repo-main",
  "roleDocuments": [
    "roles/developer/ROLE.md",
    "roles/developer/references/core.md"
  ],
  "sharedReferences": [
    "references/quality/verification.md",
    "references/quality/static-analysis.md"
  ],
  "stacks": [
    "stacks/js-ts/STACK.md"
  ],
  "stackReferences": [
    "stacks/js-ts/references/typescript.md",
    "stacks/js-ts/references/testing.md"
  ],
  "methodDocuments": [
    "method/escalation.md",
    "method/typed-contracts.md"
  ],
  "templates": [
    "templates/artifacts/verification-result.md"
  ],
  "checklists": []
}
```

Minimal prompt instruction:

```text
Load .revo/context/steps/developer-implementation/selected-references.json. Read every selected path from
.revo/playbook before acting. Do not read the source playbook checkout. If any selected file is missing, return
playbook_selected_reference_missing.
```

## Changelog

- 2026-07-11: Added `graphs/`, `scripts/`, and `schemas/` to the Draft materialized playbook layout to match the
  canonical roots.
- 2026-07-11: Made materialization depend only on the pinned playbook version, execution plan, and planned workspace;
  removed live-source and composed-prompt fallback from the Draft target.
- 2026-07-01: Initial draft target contract for Revo worktree playbook materialization.
