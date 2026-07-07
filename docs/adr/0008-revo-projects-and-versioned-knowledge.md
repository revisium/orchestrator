# ADR-0008 - Revo projects and versioned knowledge

- **Status:** Draft
- **Decision date:** 2026-07-06
- **Specs:** [Revo project knowledge and migrations v1](../specs/revo-project-knowledge-migrations-v1.spec.md),
  [Revo Prisma and engine schema v1](../specs/revo-prisma-engine-schema-v1.spec.md)
- **Relates-to:** [ADR-0005](./0005-versioned-playbook-storage-and-revo-materialization.md),
  [ADR-0007](./0007-revo-storage-foundation.md),
  [issue #285](https://github.com/revisium/orchestrator/issues/285)

## Context

Revo needs a project model that is meaningful to users and automation: a project groups repositories, run history,
knowledge, ADRs, playbook overlays, settings, and future UI/API scope.

The embedded Revisium engine also uses the word "project" through `projectId`, but the engine treats that value as an
opaque grouping key. It does not own project metadata or lifecycle.

The first storage-v2 draft introduced separate ADR and KB engine projects and Revo Prisma registry rows for those
stores. That was unnecessary. A Revo project already provides the product identity; the engine only needs the same
opaque `projectId` to group branches, revisions, tables, and rows.

Revo also needs versioned ADR and knowledge storage. ADR/KB templates should be system-controlled. Users can create
and approve ADR/KB content, but they cannot edit the built-in templates themselves.

## Decision

Adopt `RevoProject` as the only Prisma project registry. Revo project rows live in the Revo Prisma database. Each
user `RevoProject` has exactly one corresponding Revisium engine project:

```text
RevoProject.id == Branch.projectId
```

ADR and KB are not separate engine projects. They are system-defined tables inside the same user project:

| Table group | Purpose | Example tables |
| --- | --- | --- |
| ADR | architectural decisions and proposals | `adr_documents`, `adr_proposals` |
| Knowledge base | project facts, repository maps, docs, durable learnings | `kb_documents`, `kb_facts` |

Run history is a later versioned table group and is out of scope for v1.

Revo does not create extra Prisma registry models for engine projects or applied template migrations. ADR/KB
schema/data migration state is handled by the embedded Revisium engine migration mechanism.

### Terminology

- **RevoProject**: product concept; a group of repositories and Revo behavior.
- **User RevoProject**: a user-visible project, `kind = USER`.
- **System RevoProject**: a hidden reserved row, `kind = SYSTEM`, used for Revo-owned system engine stores.
- **Revisium engine project**: engine data grouped by `Branch.projectId`; in Revo v1 that id is a `RevoProject.id`.
- **RevisiumStore**: Revo service/adapter that initializes and accesses engine tables for a Revo project.
- **RevisiumEngine**: runtime/service layer around embedded engine APIs, not a database entity.

### Project Identity

`Branch.projectId` is a Revo-owned foreign key to `RevoProject.id` in the Revo Prisma schema. The engine still treats
`projectId` as opaque; the foreign key is an additive Revo safety constraint, not an engine-owned contract.

The foreign key means every engine project id in the Revo product database must have a matching `RevoProject` row. V1
storage includes a reserved system `RevoProject` row with id and slug `control-plane` for playbooks, roles, pipelines,
and control-plane versioned meaning. That system project is initialized by storage/control-plane bootstrap and is not
a user project. If a later design needs another global/system engine store, it must introduce another explicit system
`RevoProject` row or revisit the foreign-key rule.

User projects are soft-deleted in v1. Revo keeps the `RevoProject` row, keeps engine rows, blocks new writes for
deleted projects, and hides deleted projects from ordinary lists. `status = DELETED` and `deletedAt IS NOT NULL` must
move together. `ARCHIVED` projects are read-only and remain visible only in archived views. System projects cannot be
archived, deleted, or renamed through user APIs.

### Templates

ADR and KB templates are system-owned and versioned with Revo releases. A template defines:

- template id (`adr` or `kb` in v1);
- required tables and schemas;
- seed rows;
- validation rules;
- Revisium migration artifacts from version N to N+1;
- whether user content tables are append-only, proposal-based, or mutable draft content.

Users cannot edit built-in templates. If Revo later supports custom templates, that is a separate product decision
with explicit trust, validation, and migration boundaries.

### ensureProject

Revo provides a service method that returns a ready engine-backed project handle:

```ts
await revisiumStore.ensureProject({
  revoProjectId,
  mode: 'write',
});
```

The method:

1. reads the `RevoProject` row and rejects non-user projects;
2. for `mode = 'read'`, resolves existing root branch/head/draft handles and returns them without creating branches,
   revisions, tables, or migration rows;
3. for `mode = 'write'` or omitted mode, rejects unless the project is active;
4. for write/default mode, creates the engine root branch, start revision, head revision, and draft revision if
   missing;
5. for write/default mode, applies missing required ADR/KB schema/data migrations through embedded engine APIs;
6. returns project handles such as engine project id, branch, head revision, and draft revision.

`ensureProject` must be idempotent and crash-recoverable. It can be called by Revo project creation, CLI, MCP,
GraphQL, run workflows, and boot-time migrations. Revo uses Prisma for Revo-owned rows and delegates versioned
table/schema work to the embedded engine. It does not add separate Prisma state for engine project readiness.

Concurrent calls rely on engine operation idempotency, `Branch` uniqueness for `(name, projectId)`, and the engine's
own migration locking. Revo may serialize initialization for one project before invoking engine APIs, but it must not
introduce a separate project registry or migration state store.

Read-only access to an archived or deleted project may resolve existing head handles without applying migrations.
Write paths must not silently mutate archived or deleted projects.

### Commit Discipline

Because ADR and KB tables share one engine project, Revo must not keep one long-lived mutable draft branch for
unrelated work.

V1 rules:

- required ADR/KB schema/data migrations use the embedded engine migration workflow and are committed through engine
  APIs;
- accepted ADR and KB writes are applied through product flows that commit their intended change set;
- run-authored ADR proposals use proposal branches such as `proposal/<runId>/<inboxId>`;
- approving an ADR proposal applies or merges that proposal into the accepted branch and commits it;
- proposal branches must not share one mutable draft branch.

This uses Revisium versioning for what it is good at: reviewable, diffable, accepted meaning. Hot run state remains in
plain Revo Prisma runtime tables.

## Alternatives

- **Store Revo projects as Revisium rows.** Rejected. Product project lifecycle needs SQL constraints, repository
  relations, indexes, and API scoping. The engine only needs opaque project ids.
- **Create a Revisium `revo_projects` table as a mirror.** Rejected. It duplicates the Prisma source of truth and
  creates synchronization questions without adding versioning value.
- **Create separate ADR and KB engine projects per Revo project.** Rejected for v1. It adds project-id derivation,
  extra registry state, and cross-project coordination. ADR and KB can be isolated with tables and branches inside the
  same engine project.
- **Add Revo-specific migration state.** Rejected. The embedded engine already owns migration state through
  `TableMigration` and engine system tables.
- **Let users edit ADR/KB templates.** Rejected for v1. Template migrations need deterministic release behavior.
- **Use one global ADR/KB engine project for all Revo projects.** Rejected. Per-project engine grouping gives simpler
  permissions, export, retention, and future cleanup.

## Consequences

- Revo project CRUD must be implemented before user-facing knowledge operations.
- `RevisiumStore` becomes the canonical adapter for project engine initialization.
- Release migrations need to iterate active user `RevoProject` rows and apply ADR/KB migrations through the same
  Revisium migration mechanism used by `ensureProject` and `revisium-migrations apply`.
- The reserved `control-plane` system project is managed by storage/control-plane bootstrap, not by user-project
  ADR/KB migrations.
- The product can later export/import one project-scoped engine store without dragging hot runtime rows.
- KB attachments and large file storage remain a separate slice; this ADR only fixes project identity, template
  ownership, and versioned ADR/KB tables.

## Validation

Implementing PRs must add tests for:

- creating a `RevoProject` does not create a Revisium `revo_projects` table;
- creating a `RevoProject` can initialize one engine project with `Branch.projectId = RevoProject.id`;
- bootstrapping creates the reserved `control-plane` system project row and engine branch;
- `Branch.projectId` rejects branches for missing Revo projects;
- `ensureProject` creates missing root branch/revisions/tables and is idempotent under concurrent calls;
- ADR and KB templates are not editable through user APIs;
- `revisium-migrations apply` uses embedded engine migration state and does not create Revo-specific migration tables;
- a run-authored ADR can be proposed, approved through a gate, and committed into the project engine store;
- concurrent ADR proposals do not share mutable draft state;
- soft-deleted Revo projects are hidden from ordinary lists and reject new run/ADR/KB writes.

## Notes for implementation

- Use eager initialization at `RevoProject` creation for ADR and KB tables, plus lazy `ensureProject` on access paths
  for self-healing.
- Keep `ensureProject` state derived from RevoProject + engine rows. Do not add separate Prisma state for engine
  project initialization in v1.
