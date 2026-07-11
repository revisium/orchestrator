# Revo project knowledge and migrations v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo project service, RevisiumStore, embedded engine integration, release migrations
- **Source files:** future `src/projects/**`, future `src/revisium-store/**`, future `src/revisium-migrations/**`,
  `prisma/schema.prisma`, `@revisium/engine`
- **Related ADRs:** [ADR-0008](../adr/0008-revo-projects-and-versioned-knowledge.md),
  [ADR-0007](../adr/0007-revo-storage-foundation.md)
- **Related specs:** [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md)

## Scope

This spec defines project-scoped Revisium engine storage for ADR/KB content, system templates, `ensureProject`, and
the development/release workflow for engine-backed schema/data migrations.

It covers:

- one engine project per user `RevoProject`;
- the reserved system `control-plane` project used for playbooks and control-plane meaning;
- system ADR/KB tables inside a user project engine store;
- `init/save/apply` development flow built on the existing Revisium migration mechanism;
- boot/release-time application of migrations;
- user edit boundaries.

It does not define UI layout, every ADR/KB table schema, or the full KB attachment/file lifecycle.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as RFC 2119 / BCP 14.

## Current Contract

Current orchestrator initializes a reserved `control-plane` project through the embedded Revisium engine and
uses engine rows for versioned control-plane meaning: playbooks, roles, pipelines, and run profiles. Mutable runtime
projections, inbox rows, events, outputs, attempts, and costs are first-party Revo Prisma models. The reserved project
name comes from `control-plane/bootstrap.config.json`.

Orchestrator has a first-class `RevoProject` Prisma model for the reserved system project and future user projects.
Orchestrator does not yet configure a `revisium-migrations` development workflow for Revo ADR/KB templates.

## Target Contract

### Project Identity

User projects map one-to-one to Revisium engine projects:

```ts
type EngineProjectId = RevoProject['id'];
```

Engine rows use that id through `Branch.projectId`. ADR and KB data are tables and rows inside that same engine
project. V1 does not create separate ADR/KB engine project ids by suffixing or otherwise deriving new project
identifiers from `RevoProject.id`.

The reserved system engine project is also represented by a hidden Prisma `RevoProject` row so the
`Branch.projectId -> RevoProject.id` FK remains valid for all engine branches:

```text
RevoProject.id: control-plane
RevoProject.slug: control-plane
RevoProject.kind: SYSTEM
```

The `control-plane` system project stores playbooks, roles, pipelines, and other control-plane/versioned-meaning
tables. It is initialized by storage/control-plane bootstrap, not by the ADR/KB `ensureProject` flow. User APIs MUST
NOT list, archive, delete, rename, or otherwise mutate system projects.

In v1, `control-plane/bootstrap.config.json` `projectName` MUST resolve to the reserved id `control-plane`. If the
field stops being configurable in a later version, the config field may be retired.

### System Tables

Initial user-project ADR/KB table groups:

| Table id | Purpose |
| --- | --- |
| `adr_documents` | Accepted ADR documents and metadata |
| `adr_proposals` | Workflow metadata pointing to one proposal document and proposal revision |
| `kb_documents` | Versioned knowledge documents with accepted-revision provenance |
| `kb_facts` | Durable facts, repository maps, and structured project knowledge with source and verification provenance |

`adr_proposals` MUST NOT store a second authoritative ADR body. A proposal row points to the proposal
document and revision:

```ts
type AdrProposalMetadata = {
  proposalId: string;
  documentId: string;
  proposalBranch: string;
  proposalRevisionId: string;
  sourceRunId?: string;
  sourceArtifactId?: string;
  status: 'draft' | 'proposed' | 'accepted' | 'rejected' | 'superseded';
  acceptedRevisionId?: string;
  reviewedAt?: string;
};
```

The proposal document body exists once in versioned document content at `proposalRevisionId`. Acceptance
commits or merges that document into the accepted branch and records `acceptedRevisionId`. The metadata row
does not copy the body.

KB documents and facts MUST carry provenance:

```ts
type KnowledgeProvenance = {
  sourceRunId?: string;
  sourceArtifactId?: string;
  sourceRepositorySnapshot?: string;
  acceptedRevisionId: string;
  status: 'accepted' | 'superseded' | 'needs_verification';
  verifiedAt: string;
};
```

Search indexes, embeddings, and vector projections MAY be derived from accepted revisions. They MUST NOT become the
authoritative document/fact body or replace provenance.

Exact user-content schemas evolve through the existing Revisium engine migration mechanism. Revo MUST NOT add a
second migration state table and MUST NOT mirror applied template versions in Revo Prisma.

The engine's built-in `Table.system`, `Row.readonly`, `TableMigration`, and engine system tables remain engine-owned.
Regardless of engine flags, Revo APIs MUST reject direct user writes to system tables, engine migration rows, and
system seed rows.

### Template Ownership

ADR and KB templates are system-owned. User APIs MUST NOT update template definitions, migration artifacts, or seed
rows.

Template files SHOULD live in a Revo-owned source tree such as:

```text
revisium-templates/
  adr/
    template.json
    tables/
    seeds/
    migrations/
  kb/
    template.json
    tables/
    seeds/
    migrations/
```

Exact path is implementation-defined, but templates must be versioned with the Revo codebase.

### Template Shape

Example:

```json
{
  "schemaVersion": "revisium-template/v1",
  "id": "adr",
  "version": 1,
  "tables": [
    {
      "id": "adr_documents",
      "schema": {
        "type": "object",
        "required": ["id", "title", "status", "body"],
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "status": { "enum": ["draft", "proposed", "accepted", "rejected", "superseded"] },
          "body": { "type": "string" }
        }
      }
    }
  ],
  "seeds": []
}
```

`version` is source artifact metadata only. Applied state is derived from the engine migration chain, not from a Revo
template-version ledger.

### Migration Mechanism

Revo reuses the embedded Revisium engine migration mechanism. The source of truth for schema/data migration state is
the engine's own migration state, including `TableMigration` and engine system migration tables.

Revo uses the existing `revisium-migrations` / embedded engine APIs directly for the developer and operator
save/apply workflow. If Revo later adds a repo-local command alias, that alias must not become a separate migration
layer and must not create Revo-specific migration state in Prisma or in additional Revisium rows.

Implementation rules:

- `save` artifacts must be compatible with the engine/core migration format used by Revisium consumers.
- `apply` must invoke embedded engine migration APIs, not raw SQL against engine tables.
- migration progress, locks, retries, and active migration status come from engine APIs such as migration/status
  reads and `applyMigrations`;
- Revo may serialize project initialization before invoking engine APIs, but it does not own engine migration locking;
- a failed required migration blocks readiness until a later forward migration or engine-supported repair path fixes
  the project.

### ensureProject

API:

```ts
type EnsureProjectInput = {
  revoProjectId: string;
  mode?: 'read' | 'write';
};

type EnsureProjectResult = {
  revoProjectId: string;
  engineProjectId: RevoProject['id'];
  branchName: string;
  headRevisionId: string;
  draftRevisionId: string;
};
```

Behavior for user projects:

1. Read the `RevoProject` row.
2. Reject unless `kind = USER`.
3. For `mode = 'read'`, resolve existing root branch/head/draft handles and return them without creating branches,
   revisions, tables, or migration rows.
4. For `mode = 'write'` or omitted mode, reject unless the project is active.
5. For write/default mode, ensure the root branch and initial head/draft revisions exist for
   `Branch.projectId = revoProjectId`.
6. For write/default mode, apply pending required ADR/KB schema/data migrations through the shared Revisium migration
   workflow.
7. Return the ready project handle.

`ensureProject` MUST be idempotent and crash-recoverable. Revo creates or updates Revo-owned Prisma rows with Prisma,
then delegates versioned table/schema work to the embedded engine.

Concurrent calls rely on engine operation idempotency, `Branch` uniqueness for `(name, projectId)`, and the engine's
own migration locking. Revo MAY serialize initialization for one project before invoking engine APIs, but it MUST NOT
introduce a separate project registry or migration state store.

Read-only access MAY resolve existing head handles for archived or deleted projects without applying migrations.
Write paths MUST reject archived or deleted projects according to product policy. Restoring or unarchiving a project
MUST call `ensureProject` before allowing new writes, because skipped release migrations may need to be applied.

### Commit Discipline

ADR and KB tables share one engine project. Revo must not keep one long-lived mutable draft branch for unrelated work.

V1 rules:

- required ADR/KB schema/data migrations use the engine migration workflow and are committed through engine APIs;
- accepted ADR/KB writes commit the intended change set promptly through product flows;
- run-authored ADR proposals use dedicated branches such as `proposal/<runId>/<inboxId>`;
- approval applies or merges a proposal into the accepted branch;
- proposal branches must not share one mutable draft branch.

This uses Revisium versioning for what it is good at: reviewable, diffable, accepted meaning. Hot run state remains in
plain Revo Prisma runtime tables.

### Route-time knowledge selection

Agents read accepted ADR/KB revisions by default. A route MAY include proposal content only when the selected pipeline
explicitly declares that proposal context.

Route planning resolves selected project knowledge to:

- project id;
- document/fact id;
- accepted or explicitly selected proposal revision id;
- content digest;
- provenance status and verification time.

The resulting pins are stored in the immutable
[execution plan](./execution-plan-v1.spec.md). Replay and recovery MUST NOT re-read a mutable branch head or search
index. A later accepted revision affects only later plans.

### Development Workflow

Revo needs a local workflow analogous to the consumer `save/apply` pattern and Prisma's migration ergonomics.
The commands below are a Revo-packaged command surface over existing Revisium migration APIs. Revo-specific flags such
as `--project` and `--all` only select Revo projects from Prisma before invoking the engine migration mechanism.
Migration artifacts use the engine/core format, and migration state remains engine-owned.

Draft CLI shape:

```sh
revisium-migrations init adr --name initial-adr-template
revisium-migrations save adr --name add-status-index
revisium-migrations apply --project <revoProjectId>
revisium-migrations apply --all
```

Meanings:

- `init` creates the first migration artifacts for a system template.
- `save` compares the working template with the latest saved migration artifact and writes the next migration using
  the existing Revisium migration format.
- `apply` applies saved migrations to one active user Revo project or all eligible active user Revo projects by
  invoking embedded engine APIs.

During Revo development, a contributor should be able to:

1. reset local data;
2. start Revo;
3. create a user Revo project;
4. edit template files;
5. run `revisium-migrations save`;
6. run `revisium-migrations apply`;
7. inspect the resulting engine tables/rows and engine migration status;
8. commit both template changes and migration artifacts.

### Release Workflow

On a new Revo version, follow the canonical bootstrap order in
[storage database layout v1](./storage-database-layout-v1.spec.md#bootstrap-order). During the project-knowledge
phase:

1. Revo ensures reserved system `RevoProject` rows such as `control-plane` exist.
2. Revo initializes or migrates the `control-plane` system project through the control-plane bootstrap path.
3. Revo scans active user `RevoProject` rows.
4. For each active user project, Revo invokes the same Revisium migration mechanism used by `ensureProject` and
   `revisium-migrations apply`.
5. Missing required ADR/KB migrations are applied in order.
6. Required migration failures block host readiness until a later successful retry or forward migration fixes the
   project.

All migration application paths share one implementation. Boot-time apply, lazy `ensureProject`, and
`revisium-migrations apply --all` MUST NOT implement separate migration logic.

### User Edit Boundaries

Users MAY edit:

- ADR documents through proposal/approval flows;
- KB rows/documents through product APIs;
- repository/project settings through Revo APIs.

Users MUST NOT edit:

- system projects such as `control-plane`;
- template definitions;
- template migration files;
- engine migration rows or engine system tables;
- system seed rows marked readonly;
- engine physical bookkeeping rows directly.

## Validation

Required tests:

- bootstrapping creates the reserved `control-plane` system `RevoProject` row;
- user `RevoProject` creation initializes one engine project id equal to `RevoProject.id`;
- `ensureProject` creates missing root branch/revisions/tables on first use;
- concurrent `ensureProject` calls do not create duplicate root branches or duplicate migration applications;
- Revo does not create Revo-specific migration tables or extra project mapping models;
- `save` creates deterministic migration artifacts using the existing Revisium migration format;
- `apply --all` applies user-template migrations only to active user Revo projects;
- release bootstrap migrates the reserved `control-plane` system project when control-plane templates change;
- engine migration failures are visible to doctor/status and do not silently mark the project ready;
- user APIs cannot modify template files, engine migration rows, or engine system tables;
- release bootstrap blocks readiness on required migration failure;
- archived or deleted projects do not receive write-time migrations.
- `adr_proposals` points to proposal document/revision metadata and does not duplicate the authoritative body;
- KB documents/facts require source, accepted revision, status, and verification-time provenance;
- route-time knowledge pins remain stable when accepted branches or derived search indexes change.

## Compatibility

Existing pre-v1 local data is outside this contract and is not migrated.

Template migrations must be forward-only. A rollback is a new forward migration that restores previous behavior.

## Examples

Creating a user Revo project and first project-scoped ADR/KB store:

```ts
const project = await revoProjects.create({
  name: 'Billing',
  slug: 'billing',
});

const store = await revisiumStore.ensureProject({
  revoProjectId: project.id,
  mode: 'write',
});
```

Result:

```json
{
  "revoProjectId": "clx_project_01",
  "engineProjectId": "clx_project_01",
  "branchName": "main",
  "headRevisionId": "rev_head_01",
  "draftRevisionId": "rev_draft_01"
}
```

The system control-plane store is initialized and migrated by the storage/control-plane bootstrap path, not by
`ensureProject`. It uses the reserved identity:

```json
{
  "revoProjectId": "control-plane",
  "engineProjectId": "control-plane",
  "branchName": "master",
  "kind": "SYSTEM"
}
```

## Changelog

- 2026-07-11: Corrected Current Contract runtime ownership to Prisma, made `adr_proposals` metadata point to
  one proposal document/revision, and added KB provenance plus route-time accepted-revision pins.
- 2026-07-06: Initial draft.
