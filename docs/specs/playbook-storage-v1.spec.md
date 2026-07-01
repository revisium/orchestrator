# Playbook storage v1 spec

- **Status:** Draft.
- **Version:** v1
- **Owners:** `src/playbook`, `src/revisium`, control-plane storage.
- **Source files:** `src/playbook/manifest.ts`, `src/playbook/catalog-loader.ts`,
  `src/playbook/import-mapper.ts`, `src/playbook/playbook-installer.ts`,
  `src/revisium/playbooks.service.ts`, `control-plane/default-playbook/playbook.json`,
  `control-plane/default-playbook/catalog/roles.json`,
  `control-plane/default-playbook/catalog/pipelines.json`, `docs/control-plane-schema.md`,
  `control-plane/bootstrap.config.json`.
- **Related ADRs:** [ADR-0005](../adr/0005-versioned-playbook-storage-and-revo-materialization.md).
- **Related specs:** [Revo playbook materialization v1](./revo-playbook-materialization-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [default-playbook-policy.spec.md](./default-playbook-policy.spec.md).

## Scope

This spec defines the versioned storage contract for Revo playbooks as Revisium/control-plane data. It covers package
identity, document records, typed entity projections, relation records, snapshot hashing, import validation, and
durable route pinning.

This spec does not define the physical `.revo` worktree layout. That is owned by
[revo-playbook-materialization-v1.spec.md](./revo-playbook-materialization-v1.spec.md). It also does not define runner
selection, provider model names, or execution-profile override policy.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Current Contract

The shipped installer resolves a local or package playbook source, reads `playbook.json`, reads role and pipeline
catalogs, and writes rows into versioned meaning storage:

- `playbooks`
- `roles`
- `pipelines`

The current manifest schema version is `2`. The manifest contains:

```json
{
  "id": "revisium-default",
  "name": "Revisium default playbook",
  "schema_version": 2,
  "package": "@revisium/orchestrator-default-playbook",
  "catalogs": {
    "roles": "catalog/roles.json",
    "pipelines": "catalog/pipelines.json"
  },
  "supported_runtimes": ["revo"]
}
```

The role catalog parser currently requires:

- `id`
- `path`
- `surface`
- `rights`
- `allowed_tools`
- `default_model_level`
- `runner_id`
- optional `wrappers`

The pipeline catalog parser currently requires:

- `id`
- `path`
- `triggers`
- `required_roles`
- `alternative_roles`
- `optional_roles`
- `route_gates`
- `platform_invocation`
- optional `execution_policy`

The importer validates unique role ids, unique pipeline ids, catalog path containment, referenced pipeline role ids,
allowed model-level ids, and production-blocked runner ids. It composes a role `system_prompt` from the role source
and a sibling `references/core.md` when present.

The current contract does not store full source documents, stack references, shared references, method docs,
templates, checklists, route-time selected references, or a complete immutable snapshot.

## Target Migration

### Core records

Playbook storage MUST add a complete immutable snapshot model. The logical records are listed below. Physical table
names can differ if the fields and behavior are preserved.

#### `PlaybookVersion`

`PlaybookVersion` is the immutable package-level record.

```ts
type PlaybookVersion = {
  id: string;
  playbookId: string;
  name: string;
  packageName: string;
  packageVersion: string;
  source: string;
  schemaVersion: number;
  snapshotHash: string;
  contentTreeHash: string;
  catalogHash: string;
  documentCount: number;
  runtimeDocumentCount: number;
  canonicalRoots: string[];
  excludedRoots: string[];
  createdAt: string;
};
```

`id` MUST be stable for the installed version and unique across playbook versions. `snapshotHash` and
`contentTreeHash` are defined in "Hashing" below.

#### `PlaybookDocument`

`PlaybookDocument` stores source content as installed.

```ts
type PlaybookDocument = {
  playbookVersionId: string;
  documentId: string;
  path: string;
  kind:
    | "manifest"
    | "catalog"
    | "role"
    | "pipeline"
    | "role_reference"
    | "shared_reference"
    | "stack"
    | "stack_reference"
    | "method"
    | "template"
    | "checklist"
    | "auxiliary";
  mediaType: "application/json" | "text/markdown" | "text/plain";
  rawContent: string;
  normalizedContentHash: string;
  contentHash: string;
  frontmatterJson?: string;
  title?: string;
  ownerId?: string;
  runtimeIncluded: boolean;
};
```

`documentId` SHOULD default to the normalized relative path. Paths MUST be relative, normalized with `/`, and MUST NOT
escape the playbook root.

`contentHash` is the SHA-256 of the exact UTF-8 bytes that will be materialized. `normalizedContentHash` is the
SHA-256 of the markdown or JSON content after deterministic normalization: UTF-8 decode, CRLF to LF, removal of
trailing spaces, one final newline, and stable JSON stringification for JSON documents.

#### `PlaybookRole`

`PlaybookRole` is the typed projection of a role catalog record and matching role document.

```ts
type PlaybookRole = {
  playbookVersionId: string;
  roleId: string;
  documentId: string;
  path: string;
  surface: string;
  rights: string;
  allowedTools: string[];
  defaultModelLevel: string;
  runnerId: string;
  wrapperPaths: Record<string, string>;
  coreReferenceDocumentId?: string;
};
```

The role projection MUST validate catalog metadata against role frontmatter when frontmatter is present.

#### `PlaybookPipeline`

`PlaybookPipeline` is the typed projection of a pipeline catalog record and matching pipeline document.

```ts
type PlaybookPipeline = {
  playbookVersionId: string;
  pipelineId: string;
  documentId: string;
  path: string;
  triggers: string[];
  requiredRoles: string[];
  alternativeRoles: Array<{
    groupId: string;
    roles: string[];
    resolution: string;
  }>;
  optionalRoles: string[];
  routeGates: string[];
  platformInvocation: string;
  executionPolicyJson: string;
};
```

Every role id referenced by `requiredRoles`, `alternativeRoles`, or `optionalRoles` MUST resolve to a `PlaybookRole`
inside the same `PlaybookVersion`.

#### `PlaybookStack`

`PlaybookStack` represents a stack dispatcher such as `stacks/js-ts/STACK.md`.

```ts
type PlaybookStack = {
  playbookVersionId: string;
  stackId: string;
  documentId: string;
  path: string;
  coreReferenceDocumentIds: string[];
  conditionalReferenceDocumentIds: string[];
  routeEvidenceText?: string;
};
```

The importer SHOULD derive `stackId` from `stacks/<stack>/STACK.md` until stack catalog files exist.

#### `PlaybookReference`

`PlaybookReference` classifies reusable knowledge documents.

```ts
type PlaybookReference = {
  playbookVersionId: string;
  referenceId: string;
  documentId: string;
  path: string;
  scope: "role" | "shared" | "stack";
  ownerId?: string;
  category?: string;
};
```

Examples:

- `roles/developer/references/core.md` -> `scope: "role"`, `ownerId: "developer"`
- `references/quality/verification.md` -> `scope: "shared"`, `category: "quality"`
- `stacks/js-ts/references/typescript.md` -> `scope: "stack"`, `ownerId: "js-ts"`

#### `PlaybookRelation`

`PlaybookRelation` stores links without requiring database self-relations.

```ts
type PlaybookRelation = {
  playbookVersionId: string;
  relationId: string;
  sourceKind: string;
  sourceId: string;
  relationType:
    | "requires_role"
    | "alternative_role"
    | "optional_role"
    | "has_document"
    | "has_core_reference"
    | "has_shared_reference"
    | "has_stack_reference"
    | "uses_template"
    | "refines_method";
  targetKind: string;
  targetId?: string;
  targetPath?: string;
  metadataJson?: string;
  required: boolean;
};
```

When `required` is true, the importer MUST validate that the target exists in the same snapshot. Optional relations
SHOULD still be validated when the target is present.

Relations are a query/index aid. Entity projections remain the source of truth for fields that require structure,
such as `PlaybookPipeline.alternativeRoles[].groupId` and `resolution`. A relation MAY duplicate that data in
`metadataJson`, but readers MUST NOT rely on relations alone to reconstruct pipeline semantics.

### Canonical roots

The target canonical runtime roots are:

```text
playbook.json
catalog/
roles/
pipelines/
references/
stacks/
method/
templates/
checklists/
```

The importer MUST store every present canonical runtime root. Roots are optional during migration because the current
bundled default playbook is flat: role catalog paths point at `prompts/<role>.md`, and the package has no `roles/`,
`stacks/`, `method/`, `templates/`, or `checklists/` roots yet. A missing canonical root is not an import failure
unless a catalog, frontmatter field, or selected reference points into it. Catalog-addressed runtime documents outside
canonical roots, such as `prompts/<role>.md` in the flat default playbook, MUST still be stored as
`runtimeIncluded: true` documents.

The importer MUST exclude `.git`, `.github`, generated adapter output, local overlays, and `legacy/` from the default
runtime snapshot. A future audit mode MAY retain those documents as `runtimeIncluded: false`.

`documentCount` counts all stored documents in the snapshot, including optional audit documents when audit mode is
enabled. `runtimeDocumentCount` counts only `runtimeIncluded: true` documents and MUST match the materialized
runtime-file count excluding `.revo/playbook/manifest.json`.

### Hashing

Hashing MUST be deterministic across platforms and repeated imports:

- enumerate documents by `documentId` ascending;
- enumerate entity projections and relations by their stable ids ascending;
- use UTF-8 strings;
- use the same stable JSON stringifier as the importer uses for catalog hashes: object keys sorted lexicographically,
  arrays preserved in semantic order;
- hash with SHA-256 and lowercase hex encoding.

`contentTreeHash` covers only `runtimeIncluded: true` document paths, kinds, and raw `contentHash` values in sorted
order. It is the hash that `.revo` materialization can recompute from files.

`snapshotHash` covers the `contentTreeHash` plus typed projections and required relations. It is the stronger storage
identity for the whole imported version.

### Route-time selection

Route planning MUST pin playbook selection into the durable route decision. The route decision is the DBOS workflow
argument/replay seam for data-driven runs; future `task_runs` columns MAY project these fields for query speed, but
the durable source of truth is the route decision payload.

The pinned shape is:

```ts
type PlaybookSelectionPin = {
  playbookVersionId: string;
  snapshotHash: string;
  contentTreeHash: string;
  pipelineId: string;
  roleIds: string[];
  nodeSelections: Array<{
    nodeId: string;
    roleId: string;
    selectedDocumentIds: string[];
    selectedReferenceIds: string[];
    selectedStackIds: string[];
  }>;
};
```

Replay and recovery MUST use this pin. They MUST NOT re-resolve the latest playbook package or live source path.

## Validation

Storage validation MUST cover:

- `playbook.json` schema version and catalog path containment;
- unique role ids, pipeline ids, stack ids, document ids, and reference ids;
- role catalog path exists and points to a role document;
- pipeline catalog path exists and points to a pipeline document;
- pipeline role references resolve inside the same snapshot;
- `default_model_level` remains in the allowed portable or Codex model-level vocabulary;
- production role catalog rows do not bind `runner_id` to `stub-agent`;
- role frontmatter matches catalog id, surface, rights, default model level, and runner id when present;
- stack references listed in `STACK.md` resolve inside the stack directory when the stack root exists;
- markdown links that point inside canonical roots resolve or are explicitly marked optional;
- `contentTreeHash` and `snapshotHash` are deterministic across repeated imports of identical content.

Unit tests SHOULD use a fixture copied from the canonical `agent-playbook` layout. Integration tests SHOULD prove that
the bundled flat default playbook can be imported into the target storage model without pretending it has role-local
core references.

## Compatibility

Existing rows in `playbooks`, `roles`, and `pipelines` remain the compatibility surface for current runtime code until
the materializer and route planner consume `PlaybookVersion` directly.

The target importer SHOULD dual-write compatibility rows and snapshot rows during migration. Removing `roles.system_prompt`
as the primary prompt source requires a separate migration because existing runners read that field.

`schema_version: 2` remains supported for the current manifest. Adding snapshot document storage does not require a
manifest bump by itself unless authoring fields change.

## Examples

Minimal relation example:

```json
{
  "playbookVersionId": "revisium-agent-playbook@0.1.0:sha256:abc",
  "sourceKind": "pipeline",
  "sourceId": "feature-development",
  "relationType": "requires_role",
  "targetKind": "role",
  "targetId": "developer",
  "required": true
}
```

Minimal role reference projection:

```json
{
  "playbookVersionId": "revisium-agent-playbook@0.1.0:sha256:abc",
  "referenceId": "roles/developer/references/core.md",
  "documentId": "roles/developer/references/core.md",
  "path": "roles/developer/references/core.md",
  "scope": "role",
  "ownerId": "developer"
}
```

## Changelog

- 2026-07-01: Initial draft target contract for full versioned playbook storage.
