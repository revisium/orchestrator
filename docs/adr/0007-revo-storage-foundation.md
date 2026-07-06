# ADR-0007 - Revo storage foundation

- **Status:** Draft
- **Decision date:** 2026-07-06
- **Specs:** [storage database layout v1](../specs/storage-database-layout-v1.spec.md),
  [Revo Prisma and engine schema v1](../specs/revo-prisma-engine-schema-v1.spec.md)
- **Relates-to:** [ADR-0001](./0001-execution-engine-and-host.md),
  [ADR-0005](./0005-versioned-playbook-storage-and-revo-materialization.md),
  [ADR-0006](./0006-run-profiles-and-provider-neutral-pipelines.md),
  [run dataflow v1](../specs/run-dataflow-v1.spec.md),
  [human gates v1](../specs/human-gates-v1.spec.md),
  [issue #285](https://github.com/revisium/orchestrator/issues/285)

## Context

Revo currently uses Revisium standalone as the local storage daemon. The NestJS host starts or reuses that daemon,
discovers its embedded PostgreSQL port, creates the DBOS system database, and then launches DBOS.

That design was enough to bootstrap the product, but it now puts the wrong data in the wrong store:

- hot runtime rows live in Revisium draft tables even though they need SQL transactions, retention, and single-writer
  status semantics;
- DBOS already owns durable workflow progress and replay, so runtime status reconciliation across multiple stores has
  produced real consistency bugs;
- Revisium standalone adds a second daemon boundary and a localhost HTTP hop even though the extracted
  `@revisium/engine` package can be embedded in the host;
- Revo needs first-class product/runtime data such as projects, repositories, runs, attempts, inbox items, events,
  outputs, artifacts, and cost ledgers.

The first issue #285 design capture proposed separate `engine`, `revo_runtime`, and `dbos` databases. Follow-up design
review changed that: the engine does not own a project registry, and Revo needs one Prisma schema that includes both
Revo-owned product/runtime tables and the engine-required physical tables. DBOS remains separate because its schema is
owned and migrated by the DBOS SDK.

This ADR ignores legacy local data. Revo is still an internal alpha, so there is no compatibility requirement to read
or migrate existing user data directories.

## Decision

Adopt a Revo-owned storage foundation with one embedded PostgreSQL cluster and two logical databases:

| Database | Owner | Contents | Migration owner |
| --- | --- | --- | --- |
| Revo product DB, profile-specific name such as `revo` / `revo_dev` | Revo | Revo product/runtime tables plus engine-required physical tables | Revo Prisma migrations |
| DBOS system DB, profile-specific name such as `dbos` / `dbos_dev` | DBOS SDK, provisioned by Revo | DBOS workflow, queue, notification, schedule, event, stream, and migration tables under schema `dbos` | DBOS SDK system migrations at `DBOS.launch()` |

The embedded PostgreSQL cluster is Revo-owned. The host is responsible for starting it directly, discovering its
proven port, creating required databases, running Revo migrations through Prisma Migrate, configuring
`@revisium/engine`, configuring DBOS, and failing startup if any plane is inconsistent.

`@revisium/standalone` is removed from the Revo storage path. Revo must not call `ensureRevisium()`, discover storage
through standalone runtime JSON, or rely on the standalone HTTP health endpoint during normal startup.

### Revo product database

The Revo product DB is the only Prisma database managed by Revo. It contains:

- Revo business entities such as `RevoProject`, repositories, project settings, and template migration ledgers;
- hot runtime entities such as runs, tasks, attempts, inbox items, events, outputs, costs, and artifact indexes;
- engine-required physical tables: `Branch`, `Revision`, `Table`, `Row`, `FileBlob`, `ProjectFileUsage`, and
  `TableMigration`.

Revo does not create a Revisium table named `revo_projects`. The Revo project registry is a Prisma model. The engine
receives opaque `projectId` strings and does not own project lifecycle.

### Engine embedding

Embed `@revisium/engine` in the Revo host process instead of calling Revisium standalone over HTTP for product
runtime paths. The engine remains a versioning library: branches, revisions, tables, rows, JSON Schema, diffs, file
usage, and table migrations.

The current `revisium-core` pattern does not prove a shared transaction boundary between product services and
`@revisium/engine`. `revisium-core` imports `EngineModule.forRoot(...)`, but `revisium-core` and `revisium-engine`
each define their own generated Prisma client and their own `TransactionPrismaService`. Core project creation writes
`Project`, `Branch`, `Revision`, and system tables directly through the core Prisma transaction; engine API calls use
the engine transaction service for engine operations. Therefore Revo v1 must not depend on cross-client atomic
transactions unless a dedicated engine extension point/PoC proves it.

Engine-required Prisma models must be generated, imported, or checked from the engine package. Revo must not maintain
a hand-copied schema fragment without drift detection.

Field names used by the engine are part of the integration contract. In particular:

- keep `Branch.projectId` as `projectId`;
- keep `Revision.sequence Int @unique @default(autoincrement())`, matching `revisium-core` and `revisium-engine`;
- do not rename engine fields through Prisma aliases unless the engine package explicitly supports that contract.

### DBOS placement

DBOS remains system-owned. Revo provisions the DBOS database, passes `systemDatabaseUrl` into `DBOS.setConfig`, and
then calls `DBOS.launch()`. DBOS creates and upgrades its own `dbos` schema through its internal system migrations.

Revo Prisma migrations must not create, modify, introspect, or depend on DBOS tables. Product code must continue to
access DBOS through the sealed `DbosService` boundary, not raw DBOS SQL tables.

The local PoC on 2026-07-06 verified this placement: a single embedded PostgreSQL cluster can host a product database
and a DBOS database; DBOS creates its tables under the `dbos` schema inside the DBOS database; the product database
does not receive DBOS tables. That PoC reused an existing dev cluster; the first implementation slice must still
prove the fresh Revo-owned cluster path without Revisium standalone.

### Bootstrap order

Host bootstrap is a contract:

1. resolve profile, data directory, HTTP port, PostgreSQL port, and database names;
2. start or reuse the Revo-owned embedded PostgreSQL cluster;
3. connect to the maintenance database;
4. create the Revo product DB if missing;
5. create the DBOS system DB if missing;
6. run `prisma migrate deploy` or an equivalent Prisma Migrate deploy invocation against the Revo product DB;
7. initialize the embedded engine with the Revo Prisma/database connection and file storage adapter;
8. verify and apply required Revo template/data migrations through the same serialized migrator used by
   `revisium-migrations apply`;
9. configure and launch DBOS against the DBOS system DB;
10. start serving CLI/MCP/GraphQL/HTTP traffic.

Any failure before the host is ready is fatal. The host must not accept requests with only some storage planes
initialized.

### Files

Run artifacts and worktrees remain filesystem-managed with a retention contract.

Knowledge-base attachments and larger file storage are a separate implementation slice. Storage v2 must keep an
engine-compatible `IStorageService` boundary, but v1 ADR/KB project provisioning does not need to deliver the full
attachment lifecycle.

## Alternatives

- **Keep Revisium standalone and draft-stored runtime rows.** Rejected. It preserves stale reads, non-transactional
  gate resolution, daemon lifecycle complexity, and unbounded draft growth.
- **Use separate `engine`, `revo_runtime`, and `dbos` databases.** Rejected after follow-up design review. The engine
  has requirements on physical tables, but Revo needs a single Prisma-managed product/runtime database that can
  contain those tables and its own product entities. Separating engine and Revo runtime would add cross-database
  coordination without giving engine-level ownership of projects. PostgreSQL has no cross-database foreign keys or
  ordinary transactions, so a separate engine database would also make `ensureProject`, template ledger updates, and
  ADR approval commits harder to make atomic.
- **Put DBOS tables in the Revo product DB.** Rejected. DBOS owns and migrates its schema independently; mixing it
  with Revo Prisma increases migration and introspection risk without improving product semantics.
- **Maintain two Prisma schemas against the same database.** Rejected as the base contract. Revo owns one Prisma
  schema for its product DB. Engine-required models are included through a generated or verified fragment rather than
  a second runtime Prisma ownership plane.
- **Model Revo projects inside Revisium tables.** Rejected. `RevoProject` is a product entity. Revisium virtual
  projects are created on demand from Revo project rows and templates.

## Consequences

- `ensurePostgres` should become an `ensureDatabases` or `StorageBootstrapService` concept that starts Revo-owned
  embedded PostgreSQL, provisions both Revo and DBOS databases, and runs Prisma Migrate for the Revo DB.
- Orchestrator gains its own Prisma schema, migrations, and generated client.
- The current control-plane data-access layer must be reimplemented over Revo Prisma for runtime tables while keeping
  transport adapters thin.
- The embedded engine package version and engine schema fragment become pinned build inputs.
- The engine schema fragment should be generated from the pinned engine package and verified by CI using a stable
  schema hash or diff. Revo must not rely on manual copy/paste review for engine-required tables.
- DBOS upgrade behavior is tied to the installed DBOS SDK version; Revo can report DBOS DB/version status but does
  not own DBOS DDL.
- Local reset becomes simple during alpha: stop Revo, delete the data directory, start again.
- The orchestrator must depend on the embedded PostgreSQL provider directly or through a Revo-owned wrapper, not
  transitively through `@revisium/standalone`.

## Validation

Implementing PRs must add tests and smokes for:

- profile-specific database name resolution for Revo DB and DBOS DB;
- bootstrap creates missing Revo and DBOS databases idempotently;
- fresh-cluster bootstrap works without Revisium standalone;
- DBOS launch creates or upgrades only the DBOS database and leaves the Revo product database free of DBOS tables;
- Revo Prisma migrations create expected product/runtime and engine-required tables;
- engine API can create a revision/table/row using a `RevoProject`-derived opaque project id;
- `Revision.sequence` remains globally unique and autoincrementing;
- engine schema fragment drift fails CI;
- product code cannot import raw DBOS SQL access outside the DBOS adapter boundary;
- startup fails before serving when a required database or migration plane fails;
- reset/dev flows can recreate a clean data directory without legacy assumptions.

## Notes for implementation

- Use Prisma Migrate for Revo DB DDL. The bootstrap service still owns database creation, ordering, readiness, and
  failure behavior.
- Treat engine writes as external idempotent steps guarded by Revo Prisma state until an explicit engine transaction
  injection contract exists.
