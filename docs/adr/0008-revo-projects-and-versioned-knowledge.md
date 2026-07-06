# ADR-0008 - Revo projects and versioned knowledge

- **Status:** Draft
- **Decision date:** 2026-07-06
- **Specs:** [Revisium virtual projects and migrations v1](../specs/revisium-virtual-projects-and-migrations-v1.spec.md),
  [Revo Prisma and engine schema v1](../specs/revo-prisma-engine-schema-v1.spec.md)
- **Relates-to:** [ADR-0005](./0005-versioned-playbook-storage-and-revo-materialization.md),
  [ADR-0007](./0007-revo-storage-foundation.md),
  [issue #285](https://github.com/revisium/orchestrator/issues/285)

## Context

Revo needs a project model that is meaningful to users and automation: a project groups repositories, run history,
knowledge, ADRs, playbook overlays, settings, and future UI/API scope.

Revisium engine also uses the word "project" operationally through `projectId`, but the engine treats that value as
an opaque grouping key. It does not model project metadata or lifecycle.

Conflating those two meanings would make the storage model harder to reason about. Revo should own product projects;
Revisium should provide versioned stores for structured knowledge.

Revo also needs versioned ADR and knowledge storage. ADR/KB templates should be system-controlled. Users can create
and approve ADR/KB content, but they cannot edit the built-in templates themselves.

## Decision

Adopt `RevoProject` as the only product-level project registry. Revo projects live in the Revo Prisma database.

Each Revo project can have one or more Revisium virtual projects. ADR and KB virtual projects are provisioned during
Revo project creation by calling the same `ensureProject` path used everywhere else. All read/write access paths still
call `ensureProject` as a lazy, idempotent self-healing fallback if provisioning was skipped, interrupted, or added by
a later release:

| Virtual project | Purpose | Engine project id example |
| --- | --- | --- |
| ADR store | architectural decisions and decision proposals | `<revoProjectId>__adr` |
| Knowledge base | project facts, docs, repo maps, durable learnings | `<revoProjectId>__kb` |

Run history is a later virtual project kind and is out of scope for v1.

Virtual projects are not listed in a Revisium table named `revo_projects`. They are derived from Revo Prisma rows and
created by a Revo service such as `RevisiumStore.ensureProject()`.

### Terminology

- **RevoProject**: user/product concept; a group of repositories and Revo behavior.
- **Revisium virtual project**: opaque engine `projectId` plus versioned tables/rows created from a Revo-owned
  template.
- **RevisiumStore**: Revo service/adapter that provisions and accesses virtual projects.
- **RevisiumEngine**: runtime/service layer around embedded engine APIs, not a database entity.

### Templates

ADR and KB templates are system-owned and versioned with Revo releases. A template defines:

- virtual project kind (`adr` or `kb` in v1);
- required tables and schemas;
- seed rows;
- validation rules;
- migration functions from version N to N+1;
- whether user content tables are append-only, proposal-based, or mutable draft content.

Users cannot edit built-in templates. If Revo later supports custom templates, that is a separate product decision
with explicit trust, validation, and migration boundaries.

### ensureProject

Revo provides a service method that returns a ready virtual project:

```ts
await revisiumStore.ensureProject({
  revoProjectId,
  kind: 'adr',
});
```

The method:

1. reads the `RevoProject` row;
2. locks or creates the `RevisiumVirtualProject` registry row;
3. derives or loads the virtual engine project id from that row;
4. moves the registry through recoverable states such as `PROVISIONING`, `MIGRATING`, `READY`, and `FAILED`;
5. creates the engine root branch/revision if missing;
6. applies template migrations to the current template version through the shared migrator;
7. returns project handles such as engine project id, branch, head/draft revision, and template version.

`ensureProject` must be idempotent and crash-recoverable. It can be called by Revo project creation, CLI, MCP,
GraphQL, run workflows, and boot-time migrations. The current `revisium-core` integration pattern does not prove that
engine operations can join a product Prisma transaction, so Revo v1 treats engine writes as external idempotent steps
guarded by the virtual-project registry state.

### ADR flow

Run-authored ADRs are proposals until a human accepts them.

Target flow:

1. an agent drafts an ADR proposal on a proposal branch such as `proposal/<runId>/<inboxId>`;
2. Revo creates a human gate/inbox item with the proposal summary and diff;
3. human approves/rejects/requests changes;
4. on approval, Revo applies or merges the proposal into the ADR virtual project's accepted branch and commits it;
5. the run records the accepted ADR id/revision in runtime events and outputs.

ADR proposals must not share one mutable draft branch. A shared draft can accidentally commit unrelated pending
proposals together.

This uses Revisium versioning for what it is good at: reviewable, diffable, accepted meaning. Hot run state remains in
plain Revo Prisma runtime tables.

## Alternatives

- **Store Revo projects as Revisium rows.** Rejected. Product project lifecycle needs SQL constraints, repository
  relations, indexes, and API scoping. The engine only needs opaque project ids.
- **Create a Revisium `revo_projects` table as a mirror.** Rejected. It duplicates the Prisma source of truth and
  creates synchronization questions without adding versioning value.
- **Let users edit ADR/KB templates.** Rejected for v1. Template migrations need deterministic release behavior.
- **Use one global ADR/KB Revisium project for all Revo projects.** Rejected. Per-project versioned stores give
  simpler permissions, migration ledgers, retention, and export.

## Consequences

- Revo project CRUD must be implemented before user-facing knowledge operations.
- `RevisiumStore` becomes the canonical adapter for virtual project provisioning.
- Template migration state belongs in Revo Prisma, not in DBOS and not in a mirrored Revisium project registry.
- Release migrations need to iterate registered virtual projects and apply template migrations through the same
  serialized migrator used by `ensureProject` and `revisium-migrations apply`.
- The product can later export/import ADR/KB virtual projects without dragging hot runtime rows.
- KB attachments and large file storage remain a separate slice; this ADR only fixes project identity, template
  ownership, and versioned ADR/KB stores.

## Validation

Implementing PRs must add tests for:

- creating a `RevoProject` does not create a Revisium `revo_projects` table;
- creating a `RevoProject` invokes `ensureProject` for ADR and KB virtual projects;
- `ensureProject` creates a missing ADR or KB virtual project on first use and is idempotent under concurrent calls;
- ADR and KB templates are not editable through user APIs;
- template migration ledger records applied template version per Revo project and virtual project kind;
- a run-authored ADR can be proposed, approved through a gate, and committed into the ADR virtual project;
- concurrent ADR proposals do not share mutable draft state;
- deleting or archiving a Revo project prevents new virtual project writes and schedules engine/file cleanup.

## Notes for implementation

- Use eager provisioning at `RevoProject` creation for ADR and KB, plus lazy `ensureProject` on every access path for
  self-healing.
- Keep engine operations behind recoverable state-machine steps unless a later engine contract explicitly supports
  injected Prisma transactions.
