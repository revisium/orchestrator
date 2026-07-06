# Revisium virtual projects and migrations v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo project service, RevisiumStore, embedded engine integration, release migrations
- **Source files:** future `src/projects/**`, future `src/revisium-store/**`, future `src/revisium-migrations/**`,
  future `prisma/schema.prisma`, `revisium-engine/**`
- **Related ADRs:** [ADR-0008](../adr/0008-revo-projects-and-versioned-knowledge.md),
  [ADR-0007](../adr/0007-revo-storage-foundation.md)

## Scope

This spec defines virtual Revisium projects, system templates, `ensureProject`, and the development/release workflow
for template migrations.

It covers:

- virtual project kinds;
- system templates;
- template migration ledger;
- `init/save/apply` development flow;
- boot/release-time application of migrations;
- user edit boundaries.

It does not define UI layout or every ADR/KB table schema.
It also does not define the full KB attachment/file lifecycle; that is a separate implementation slice.

## Current Contract

Current orchestrator installs a control-plane project into Revisium standalone and uses Revisium rows for playbooks,
roles, pipelines, runtime projections, inbox rows, and events.

There is no first-class `RevoProject` Prisma model in orchestrator today. There is no `revisium-migrations`
development workflow in orchestrator today.

## Target Contract

### Virtual project kinds

Initial virtual project kinds:

| Kind | Required | Description |
| --- | --- | --- |
| `adr` | yes for projects that use ADR flow | Versioned architectural decisions and proposals |
| `kb` | yes for projects that use knowledge base | Versioned project knowledge, repo maps, docs, durable facts |
`history` is a later project kind and is intentionally excluded from v1 models and APIs.

ADR and KB virtual projects SHOULD be provisioned during `RevoProject` creation by calling `ensureProject` for both
kinds. They MUST also be lazily created or repaired by `ensureProject` on first access, so interrupted project
creation, reset/dev flows, and future release migrations converge through the same code path.

Each virtual project is addressed by:

```ts
type VirtualProjectRef = {
  revoProjectId: string;
  kind: 'adr' | 'kb';
  engineProjectId: string;
  templateId: string;
  templateVersion: number;
};
```

`engineProjectId` is opaque to the engine. Revo stores it in the virtual-project registry row. It must not be
duplicated on `RevoProject`.

### Template ownership

Templates are system-owned. User APIs MUST NOT update template definitions, migration functions, or seed rows.

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

### Template shape

Example:

```json
{
  "schemaVersion": "revisium-template/v1",
  "id": "adr",
  "version": 1,
  "projectKind": "adr",
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

### Migration ledger

Template migration state belongs in Revo Prisma.

Draft model:

```prisma
enum RevisiumVirtualProjectKind {
  ADR
  KB
}

enum RevisiumVirtualProjectStatus {
  PROVISIONING
  MIGRATING
  READY
  FAILED
  DELETING
}

enum RevisiumTemplateMigrationStatus {
  PENDING
  APPLYING
  APPLIED
  FAILED
  BROKEN
}

model RevisiumVirtualProject {
  id              String                     @id @default(cuid())
  createdAt       DateTime                   @default(now())
  updatedAt       DateTime                   @updatedAt
  revoProject     RevoProject                @relation(fields: [revoProjectId], references: [id], onDelete: Restrict)
  revoProjectId   String
  kind            RevisiumVirtualProjectKind
  engineProjectId String                     @unique
  templateId      String
  templateVersion Int
  status          RevisiumVirtualProjectStatus @default(PROVISIONING)
  statusReason    String?
  lockedAt        DateTime?
  lastAttemptAt   DateTime?

  migrations RevisiumTemplateMigration[]

  @@unique([revoProjectId, kind])
  @@index([kind, templateId, templateVersion])
}

model RevisiumTemplateMigration {
  id               String                 @id @default(cuid())
  createdAt        DateTime               @default(now())
  virtualProject   RevisiumVirtualProject @relation(fields: [virtualProjectId], references: [id], onDelete: Cascade)
  virtualProjectId String
  templateId       String
  version          Int
  status           RevisiumTemplateMigrationStatus @default(PENDING)
  checksum         String
  startedAt        DateTime?
  appliedAt        DateTime?
  failedAt         DateTime?
  errorMessage     String?

  @@unique([virtualProjectId, templateId, version])
}
```

Field names can change, but the ledger location cannot: Prisma is the source of truth for which Revo virtual projects
have received which template migrations.

### ensureProject

API:

```ts
type EnsureProjectInput = {
  revoProjectId: string;
  kind: 'adr' | 'kb';
};

type EnsureProjectResult = {
  revoProjectId: string;
  kind: string;
  engineProjectId: string;
  branchName: string;
  headRevisionId: string;
  draftRevisionId: string;
  templateId: string;
  templateVersion: number;
};
```

Behavior:

1. Acquire a per-virtual-project lock. The implementation may use a transaction-scoped PostgreSQL advisory lock via
   raw SQL or a row-level lock on the virtual-project row.
2. Create the `(revoProjectId, kind)` virtual-project row if missing, with `status = PROVISIONING`.
3. Store exactly one `engineProjectId` on that row.
4. Ensure root branch and initial revision exist in the engine using idempotent operations.
5. Set `status = MIGRATING`.
6. Load template definition and pending migration artifacts.
7. Apply missing template migrations in ascending version order through the shared migrator.
8. Mark each migration `APPLIED` only after engine operations and checksum verification succeed.
9. Set the virtual project `status = READY`.
10. Return the ready handle.

`ensureProject` MUST be idempotent and crash-recoverable. If a step fails, it marks the virtual project or migration
`FAILED` with the reason. A later run may retry migrations whose artifact declares `idempotent: true`; otherwise the
operator must provide a forward-fix migration or explicitly mark the failed version `BROKEN` through an admin-only
repair path.

The implementation MUST NOT assume that engine operations are part of the same Prisma transaction as `RevoProject` or
`RevisiumVirtualProject` writes. `revisium-core` and `revisium-engine` currently use separate generated Prisma clients
and separate transaction services, so v1 uses registry states plus idempotent engine steps as the safety boundary.

### Development workflow

Revo needs a local workflow analogous to the consumer `save/apply` pattern and Prisma's migration ergonomics.

Draft CLI shape:

```sh
revisium-migrations init adr --name initial-adr-template
revisium-migrations save adr --name add-status-index
revisium-migrations apply adr --project <engineProjectId>
revisium-migrations apply --all
```

Meanings:

- `init` creates the first template migration from the current template definition.
- `save` compares the working template with the latest saved version and writes a deterministic migration artifact.
- `apply` applies saved migrations to one virtual project or all eligible virtual projects.

Migration artifacts use a declarative JSON format in v1. They are replayed through engine APIs, not raw SQL:

```json
{
  "schemaVersion": "revisium-template-migration/v1",
  "templateId": "adr",
  "version": 2,
  "name": "add-status-index",
  "idempotent": true,
  "ops": [
    { "op": "ensureTable", "tableId": "adr_documents", "schemaRef": "tables/adr_documents.schema.json" },
    { "op": "upsertSeedRow", "tableId": "adr_documents", "rowId": "index", "dataRef": "seeds/index.json" }
  ]
}
```

The checksum is `sha256` of the canonical JSON artifact: UTF-8, sorted object keys, LF line endings, no insignificant
whitespace. Boot and apply commands must compare the recorded checksum with the current artifact and fail on mismatch
unless an admin-only repair command marks the old row `BROKEN`.

During Revo development, a contributor should be able to:

1. reset local data;
2. start Revo;
3. create a Revo project;
4. edit template files;
5. run `revisium-migrations save`;
6. run `revisium-migrations apply`;
7. inspect the resulting engine tables/rows;
8. commit both template changes and migration artifacts.

### Release workflow

On a new Revo version:

1. Revo boots storage.
2. Revo runs Prisma migrations.
3. Revo initializes the embedded engine.
4. Revo scans existing `RevisiumVirtualProject` rows.
5. For each row, Revo invokes the same serialized migrator used by `ensureProject` and `revisium-migrations apply`.
6. Missing required template migrations are applied in order.
7. Failures block host readiness unless the migration is explicitly marked lazy/optional.

Lazy creation still goes through `ensureProject`: if a project had no `adr` virtual project before, the first ADR
operation creates it at the latest template version.

All migration application paths share one lock and one implementation. Boot-time apply, lazy `ensureProject`, and
`revisium-migrations apply --all` MUST NOT implement separate migration logic.

### User edit boundaries

Users MAY edit:

- ADR documents through proposal/approval flows;
- KB rows/documents through product APIs;
- repository/project settings through Revo APIs.

Users MUST NOT edit:

- template definitions;
- template migration files;
- migration ledger rows;
- system seed rows marked readonly;
- engine physical bookkeeping rows directly.

## Validation

Required tests:

- `RevoProject` creation calls `ensureProject` for ADR and KB virtual projects;
- `ensureProject` creates a virtual project on first use when the eager creation path did not run or was interrupted;
- concurrent `ensureProject` calls produce one virtual project row and one engine project id;
- `ensureProject` applies migrations in version order and records checksums;
- failed migrations are visible and do not silently mark the project ready;
- `save` creates deterministic migration artifacts from template changes;
- `apply --all` applies migrations to all matching virtual projects;
- user APIs cannot modify template files or migration ledger rows;
- release bootstrap blocks readiness on required migration failure.

## Compatibility

No legacy local virtual projects need to be migrated for v1.

Template migrations must be forward-only. A rollback is a new forward migration that restores previous behavior.

## Examples

Creating a Revo project and first ADR store:

```ts
const project = await revoProjects.create({
  name: 'Billing',
  slug: 'billing',
});

const adrStore = await revisiumStore.ensureProject({
  revoProjectId: project.id,
  kind: 'adr',
});
```

Result:

```json
{
  "revoProjectId": "clx_project_01",
  "kind": "adr",
  "engineProjectId": "clx_project_01:adr",
  "templateId": "adr",
  "templateVersion": 1
}
```

## Changelog

- 2026-07-06: Initial draft.
