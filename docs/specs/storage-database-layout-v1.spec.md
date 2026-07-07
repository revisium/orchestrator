# Storage database layout v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo host lifecycle, storage bootstrap, DBOS adapter, Prisma runtime
- **Source files:** `src/config.ts`, `src/storage/ensure-storage.ts`, `src/storage/revo-database.ts`,
  `src/host/host.lifecycle.ts`, `src/engine/dbos.service.ts`, `prisma/schema.prisma`
- **Related ADRs:** [ADR-0007](../adr/0007-revo-storage-foundation.md)

## Scope

This spec defines the physical PostgreSQL layout, database ownership, profile-specific naming, bootstrap order, and
failure behavior for Revo storage v2.

It covers:

- embedded PostgreSQL cluster ownership;
- Revo product database naming and ownership;
- DBOS system database naming and ownership;
- bootstrap order;
- migration plane ordering;
- reset, backup, and doctor behavior.

It does not define:

- every product table;
- every DBOS table;
- every Revo project knowledge template;
- cloud deployment topology.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as RFC 2119 / BCP 14.

## Current Contract

Orchestrator owns a first-party Prisma schema and starts embedded PostgreSQL directly through the Revo storage
bootstrap. The host provisions the Revo product database and DBOS system database, runs Prisma Migrate against the Revo
product database, initializes the embedded Revisium engine in-process, and then calls `DBOS.launch()`.

The previous external storage-daemon contract was replaced. Revo starts embedded storage itself and must not discover
storage through external runtime files or local storage health endpoints during normal startup.

Profiles currently define DBOS database names:

| Profile | DBOS database |
| --- | --- |
| `default` | `dbos` |
| `dev` | `dbos_dev` |

`REVO_DBOS_DB` overrides the profile value and must be a SQL identifier.

DBOS creates its own schema and tables in the DBOS database during `DBOS.launch()`. Revo does not run DBOS DDL.

## Target Contract

### Physical topology

One Revo installation owns one embedded PostgreSQL cluster per profile/data directory. Revo starts that cluster
directly through a Revo-owned embedded PostgreSQL provider/wrapper. That cluster
contains at least these databases:

| Logical database | Default profile name | Dev profile name | Owner | DDL owner |
| --- | --- | --- | --- | --- |
| Revo product DB | `revo` | `revo_dev` | Revo | Revo Prisma |
| DBOS system DB | `dbos` | `dbos_dev` | DBOS SDK, provisioned by Revo | DBOS SDK |
| Maintenance DB | `postgres` | `postgres` | PostgreSQL cluster | PostgreSQL |

Custom database names MAY be supplied with environment variables:

| Env var | Purpose | Validation |
| --- | --- | --- |
| `REVO_DB` | Revo product database name | SQL identifier, <= 63 bytes, not `postgres` / `template0` / `template1` |
| `REVO_DBOS_DB` | DBOS system database name | SQL identifier, <= 63 bytes, not `postgres` / `template0` / `template1` |
| `REVO_DATA_DIR` | profile data directory override | path |
| `REVO_PORT` | Revo HTTP/GraphQL base port override | positive TCP port |
| `REVO_PG_PORT` | embedded PostgreSQL port override | positive TCP port |

The Revo product DB and DBOS system DB MUST be different database names.

### Ownership rules

Revo product DB:

- contains Revo-owned Prisma models;
- contains engine-required physical models as part of the Revo Prisma schema;
- contains `_prisma_migrations` for Revo Prisma migrations;
- may contain ordinary PostgreSQL indexes, check constraints, enum types, and advisory-lock usage owned by Revo.

DBOS system DB:

- contains a `dbos` schema owned by DBOS SDK migrations;
- contains `dbos.dbos_migrations`;
- MUST NOT be managed by Revo Prisma;
- MUST NOT be queried directly by product services outside the DBOS adapter/diagnostic boundary.

Maintenance DB:

- is used only for cluster-level checks and `CREATE DATABASE`;
- MUST NOT contain Revo product or DBOS runtime tables.

### Bootstrap order

Storage bootstrap MUST run before serving user traffic. This section is the canonical storage-v2 bootstrap order;
other ADR/spec release-flow lists are non-normative summaries and must link back here.

1. Resolve profile config and database names.
2. Start or reuse embedded PostgreSQL.
3. Verify the live `postmaster.pid` port matches runtime state.
4. Connect to `postgres`.
5. Acquire a bootstrap advisory lock in the maintenance database or otherwise serialize database creation.
6. Create Revo product DB if missing.
7. Create DBOS system DB if missing.
8. Release the maintenance lock.
9. Run `prisma migrate deploy` or an equivalent Prisma Migrate deploy invocation against Revo product DB.
10. Seed reserved system `RevoProject` rows such as `control-plane`.
11. Initialize embedded Revisium engine services against Revo product DB.
12. Initialize or migrate the `control-plane` system project for playbooks and control-plane meaning.
13. Verify and apply required Revo engine migrations for eligible projects: ADR/KB migrations for active user
    projects, and system-project migrations for reserved system projects when those templates change.
14. Configure DBOS with the DBOS system database URL.
15. Launch DBOS, letting DBOS apply its own system migrations.
16. Start transport adapters.

Startup MUST fail before step 16 if any required step fails.

The maintenance advisory lock serializes database creation only. Prisma Migrate uses its own migration lock for step
9. Reserved system project seeding in step 10 is an idempotent Revo runtime upsert after Prisma migrations, not a
Prisma migration seed. Concurrent bootstraps MUST converge on one `control-plane` row.

### Migration planes

| Plane | Applies to | Trigger | Owner |
| --- | --- | --- | --- |
| Revo Prisma schema migrations | Revo product DB DDL, including engine-required physical tables | host bootstrap / deploy via Prisma Migrate | Revo |
| Revo ADR/KB engine migrations | Revo project ADR/KB schemas, seed data, and engine migration state | host bootstrap, `ensureProject`, and `revisium-migrations apply`, all through the existing Revisium migration mechanism | Revo + embedded engine |
| DBOS system migrations | DBOS system DB schema `dbos` | `DBOS.launch()` | DBOS SDK |
| File storage layout | local filesystem keys and metadata | storage bootstrap / lazy writes | Revo |

Revo MUST NOT run DBOS system migrations manually. Revo MAY report the DBOS migration version for diagnostics by
reading `dbos.dbos_migrations` in doctor/status commands.

### Backup and reset

For internal alpha:

- pre-v2 local data is outside this contract;
- reset means deleting the Revo data directory and recreating storage from scratch;
- no automatic migration from pre-v2 local data is required unless a later ADR changes the product stage.

Before destructive storage migrations after alpha, Revo SHOULD create a `pg_dump` backup for the Revo product DB and
record its path in the host log. DBOS backup policy can be separate because DBOS stores recoverable workflow progress,
not versioned product meaning.

### Doctor and status

`revo doctor` SHOULD report:

- data directory;
- PostgreSQL process and proven port;
- Revo product DB name and migration status;
- engine schema fragment hash/drift status;
- DBOS DB name and DBOS migration version;
- whether any foreign DBOS queue pollers are connected to the active DBOS DB;
- whether the Revo product DB contains unexpected DBOS tables;
- whether DBOS DB and Revo DB names collide;
- whether non-branch engine rows, such as project file-usage rows, reference `projectId` values that no longer have a
  matching `RevoProject` row;
- whether soft-deleted projects retain expected engine rows.

## Validation

Required tests:

- database name resolver rejects invalid identifiers, reserved database names, overlong identifiers, and collisions;
- bootstrap creates both databases idempotently;
- concurrent bootstraps do not fail when both try to create the same database;
- concurrent bootstraps seed each reserved system `RevoProject` row exactly once;
- DBOS launch creates `dbos.dbos_migrations` and workflow tables only in the DBOS DB;
- Revo Prisma migration creates `_prisma_migrations` only in the Revo product DB;
- doctor flags DBOS/Revo name collision, engine schema drift, orphaned non-branch engine project ids, and unexpected
  DBOS tables in Revo DB;
- user APIs reject new writes for archived or soft-deleted projects;
- startup does not serve requests when Revo migrations fail;
- fresh bootstrap works without external storage-daemon runtime files or health checks.

## Compatibility

This contract is for the internal alpha target. Existing local data directories may be deleted. No compatibility shim
for pre-v2 draft rows is required.

## Examples

Default profile:

```text
dataDir: ~/.revo
postgres database: postgres
revo product database: revo
dbos system database: dbos
```

Dev profile:

```text
dataDir: ~/.revo-dev
postgres database: postgres
revo product database: revo_dev
dbos system database: dbos_dev
```

Isolated test profile:

```sh
REVO_DATA_DIR=/tmp/revo-storage-test \
REVO_PORT=19820 \
REVO_PG_PORT=15820 \
REVO_DB=revo_test_001 \
REVO_DBOS_DB=dbos_test_001 \
revo start
```

## Changelog

- 2026-07-06: Initial draft.
