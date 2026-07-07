# Revo Prisma and engine schema v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo runtime, Prisma runtime, embedded Revisium engine integration
- **Source files:** future `prisma/schema.prisma`, future `src/storage/**`, future `src/revisium-store/**`,
  `revisium-engine/prisma/schema.prisma`, `revisium-core/prisma/schema.prisma`
- **Related ADRs:** [ADR-0007](../adr/0007-revo-storage-foundation.md),
  [ADR-0008](../adr/0008-revo-projects-and-versioned-knowledge.md)

## Scope

This spec defines the target Prisma schema shape for the Revo product database and the integration constraints for
including engine-required physical tables in that database.

It covers:

- schema ownership;
- model naming boundaries;
- required engine model compatibility;
- Revo product/runtime table groups;
- migration workflow;
- examples of the expected Prisma model shape.

It does not define every final field on every runtime table.

## Current Contract

Current orchestrator has no first-party `prisma/schema.prisma`. Runtime rows are currently accessed through Revisium
data-access services, and DBOS is configured separately through `systemDatabaseUrl`.

`@revisium/engine` has its own Prisma schema with these core models:

- `Branch`
- `Revision`
- `Table`
- `Row`
- `FileBlob`
- `ProjectFileUsage`
- `TableMigration`

The engine treats `projectId` as an opaque string. It does not define a `Project` or `Organization` model. The
consumer owns project lifecycle and passes project identifiers into engine APIs.

`revisium-core` includes its own `Project` model and relates `Branch.projectId` to that model. Revo does not copy that
project model because Revo has different product semantics.

## Target Contract

### One Revo Prisma schema

Revo MUST have one Prisma schema for the Revo product database. That schema includes:

- Revo-owned product/runtime models;
- engine-required physical models.

There is no separate Revo-managed Prisma schema for the engine database because there is no separate engine database.

### Engine-required models

Engine-required models MUST preserve the physical and Prisma-client field names expected by `@revisium/engine`.

Minimum engine constraints:

```prisma
model Branch {
  id          String      @id
  createdAt   DateTime    @default(now())
  isRoot      Boolean     @default(false)
  name        String
  projectId   String
  // Revo-additive relation; the pinned engine fragment still owns the scalar projectId field.
  revoProject RevoProject @relation(fields: [projectId], references: [id], onDelete: Restrict)
  revisions   Revision[]

  @@unique([name, projectId])
  @@index([projectId])
}

model Revision {
  id         String   @id
  sequence   Int      @unique @default(autoincrement())
  createdAt  DateTime @default(now())
  comment    String   @default("")
  isHead     Boolean  @default(false)
  isDraft    Boolean  @default(false)
  isStart    Boolean  @default(false)
  hasChanges Boolean  @default(false)

  branchId String
  branch   Branch     @relation(fields: [branchId], references: [id], onDelete: Cascade)
  parentId String?
  parent   Revision?  @relation("parentRevision", fields: [parentId], references: [id], onDelete: SetNull)
  children Revision[] @relation("parentRevision")
  tables   Table[]

  @@index([branchId])
}
```

Hard rules:

- `Revision.sequence` remains globally unique (`@unique`) and autoincrementing.
- `Branch.projectId` remains named `projectId`; do not rename to `revisiumProjectId`.
- Engine fields are not hidden behind Prisma `@map` aliases unless the engine package explicitly supports that.
- Revo adds a Revo-owned Prisma relation and FK from `Branch.projectId` to `RevoProject.id` with `onDelete: Restrict`.
- Only `Branch.projectId` carries that database FK in v1. Engine rows such as `FileBlob` and `ProjectFileUsage` keep
  their engine-required `projectId` fields without Revo-owned FK constraints; doctor checks detect orphaned non-branch
  engine rows.
- Revo does not create a Revisium table called `revo_projects`.

The authoritative engine schema fragment MUST be generated/imported/verified from `@revisium/engine` rather than
hand-copied. The v1 target is a generated schema fragment plus CI drift verification against the pinned engine
package. The drift check must distinguish engine-required fields/indexes from explicitly Revo-owned additive indexes
or constraints, including the `Branch.projectId -> RevoProject.id` FK.

The runtime Revo `schema.prisma` is a superset of the pinned engine schema fragment: it contains the engine-required
models plus Revo-owned product/runtime models and additive Revo relations. The engine fragment is the verification
reference, not a second runtime Prisma ownership plane.

Manual copy/paste review is not an acceptable schema integration mechanism.

### Revo project model

`RevoProject` is a product/runtime model. It represents a Revo workspace/project: repositories, project settings,
knowledge-space roots, run scoping, and future UI/API identity.

Example draft:

```prisma
enum RevoProjectStatus {
  ACTIVE
  ARCHIVED
  DELETED
}

enum RevoProjectKind {
  USER
  SYSTEM
}

model RevoProject {
  id        String             @id @default(cuid())
  createdAt DateTime           @default(now())
  updatedAt DateTime           @updatedAt
  deletedAt DateTime?
  kind      RevoProjectKind    @default(USER)
  name      String
  slug      String             @unique
  status    RevoProjectStatus  @default(ACTIVE)

  repositories    RevoRepository[]
  // Future Revo runtime relations, such as TaskRun[], belong in the Revo-owned schema.
  revisiumBranches Branch[]

  @@index([status])
  @@index([kind, status])
  @@index([deletedAt])
}

model RevoRepository {
  id        String      @id @default(cuid())
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
  project   RevoProject @relation(fields: [projectId], references: [id], onDelete: Restrict)
  projectId String
  name      String
  remoteUrl String?
  localPath String?
  defaultBranch String?

  @@unique([projectId, name])
}
```

The exact field names can change during implementation, but the ownership boundary cannot: Revo project identity is a
Prisma product entity, not an engine table and not a Revisium row.

`RevoProject.id` is the engine project id. User projects use generated ids. The reserved system row uses deterministic
id and slug `control-plane` for playbooks, roles, pipelines, and control-plane versioned meaning. System projects are
hidden from user project lists and cannot be archived, deleted, or renamed through user APIs.

`status = DELETED` and `deletedAt IS NOT NULL` must move together. `ARCHIVED` projects are read-only and visible only
in archived/admin views. V1 may enforce this through product services and tests before adding database check
constraints. Revo keeps `slug @unique` in v1; deleted project slugs are not reused.

ADR and KB data are Revisium tables and rows inside the same user project engine store. Engine migration state belongs
to the embedded engine's built-in `TableMigration` and system tables. Revo does not add a separate engine-project
registry, migration state table, or mirror project rows into Revisium.

`RevoRepository` uses `onDelete: Restrict` because v1 project deletion is soft-only and repository cleanup must be an
explicit product operation, not a cascade side effect.

### Runtime table groups

The first Revo Prisma runtime schema SHOULD include these groups:

| Group | Purpose |
| --- | --- |
| Projects/repositories | `RevoProject`, repository membership, project settings, soft-delete state |
| Runs | `TaskRun`, run status, route decision pins, profile pins, requested operation |
| Tasks/nodes | current graph cursor or node-level execution state if needed outside DBOS |
| Attempts | physical runner attempts, verdict, cost, token usage, artifact refs, bounded stdout/stderr tails |
| Inbox | human gates/questions, deterministic identity, status, answer payload, signal state |
| Events | append-only run events with monotonic per-run sequence |
| Outputs | named node outputs and output summaries |
| Costs | cost ledger by run/node/attempt/provider/model |
| Artifacts | file/worktree/artifact index rows pointing to filesystem storage |

Runtime constraints SHOULD include:

- enum or check constraints for statuses/verdicts;
- idempotency unique constraints for DBOS-replayed writes;
- `RunEvent(runId, sequence)` uniqueness;
- uniqueness for active/pending inbox identity;
- indexes for status dashboards and run attention queries;
- retention-friendly timestamps and optional partitioning seams.

### DBOS exclusion

No DBOS model belongs in Revo Prisma. Do not add Prisma models for:

- `dbos.workflow_status`
- `dbos.workflow_queue`
- `dbos.notifications`
- `dbos.operation_outputs`
- `dbos.streams`
- `dbos.dbos_migrations`

DBOS state is accessed through `DbosService` only.

### Migration workflow

Development flow:

1. start from a clean Revo product DB or reset alpha data;
2. edit `prisma/schema.prisma`;
3. generate a Prisma migration with the repo-standard command;
4. run migrations on a clean DB;
5. run schema-level and runtime tests;
6. verify the engine schema fragment drift check.

Release flow: follow the canonical bootstrap order in
[storage database layout v1](./storage-database-layout-v1.spec.md#bootstrap-order). For this schema spec, the
load-bearing ordering is that Prisma migrations run before reserved `RevoProject` rows are idempotently seeded, and
the reserved rows exist before embedded engine branches are initialized.

## Validation

Required tests:

- schema composition includes all engine-required models and indexes;
- drift check fails if engine-required model fields differ from the pinned engine package;
- drift check allows Revo-owned additive constraints such as `Branch.projectId -> RevoProject.id`;
- `Revision.sequence` is globally unique;
- bootstrap creates the reserved `control-plane` system `RevoProject`;
- Revo project creation can create branch/revision/table/row data with `Branch.projectId = RevoProject.id`;
- `Branch.projectId` rejects branches for missing `RevoProject` rows;
- user APIs do not list, archive, delete, or rename system projects;
- engine can create branch/revision/table/row through the embedded Revo DB setup;
- DBOS tables are absent from Revo Prisma;
- runtime idempotency constraints protect repeated DBOS step writes.

## Compatibility

No legacy local data compatibility is required for v1.

If `@revisium/engine` changes its required schema, Revo must update the generated/imported fragment and create a
normal Revo Prisma migration. Revo must not let engine schema drift silently.

Because `Revision.sequence` is global in one physical table, sequences are globally ordered across all Revo projects
and their ADR/KB/system tables. Consumers must not infer per-project contiguous revision numbers from `sequence`.

## Examples

Engine project id for one Revo project:

```text
RevoProject.id: revo_project_01
Branch.projectId: revo_project_01
ADR tables: adr_documents, adr_proposals
KB tables: kb_documents, kb_facts
```

Engine receives only:

```ts
await engine.createRevision({
  projectId: 'revo_project_01',
  branchName: 'main',
  comment: 'Initialize project knowledge store',
});
```

It does not load or own the `RevoProject` row.

System control-plane engine id:

```text
RevoProject.id: control-plane
RevoProject.kind: SYSTEM
Branch.projectId: control-plane
Control-plane tables: playbooks, roles, pipelines
```

## Changelog

- 2026-07-06: Initial draft.
