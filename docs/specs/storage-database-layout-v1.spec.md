# Storage database layout v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo host lifecycle, storage bootstrap, DBOS adapter, Prisma runtime
- **Source files:** `src/config.ts`, `src/engine/ensure-postgres.ts`, `src/host/host.lifecycle.ts`,
  `src/engine/dbos.service.ts`, future `prisma/schema.prisma`, future storage bootstrap service
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
- every Revisium virtual project template;
- cloud deployment topology.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as RFC 2119 / BCP 14.

## Current Contract

Current orchestrator has no first-party Prisma schema. It depends on `@revisium/standalone`, which owns the embedded
PostgreSQL cluster. The host calls `ensureRevisium()`, discovers the proven PostgreSQL port from runtime state, calls
`ensurePostgres(pgPort)` to create a DBOS database, builds `dbosSystemDatabaseUrl(pgPort)`, and then calls
`DBOS.launch()`.

The target contract removes this standalone dependency. The current section documents the behavior being replaced, not
a compatibility requirement.

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
directly through a Revo-owned embedded PostgreSQL provider/wrapper, not through `@revisium/standalone`. That cluster
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
| `REVO_PORT` | Revo HTTP/MCP/GraphQL base port override | positive TCP port |
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

Storage bootstrap MUST run before serving user traffic:

1. Resolve profile config and database names.
2. Start or reuse embedded PostgreSQL.
3. Verify the live `postmaster.pid` port matches runtime state.
4. Connect to `postgres`.
5. Acquire a bootstrap advisory lock in the maintenance database or otherwise serialize database creation.
6. Create Revo product DB if missing.
7. Create DBOS system DB if missing.
8. Release the maintenance lock.
9. Run `prisma migrate deploy` or an equivalent Prisma Migrate deploy invocation against Revo product DB.
10. Initialize embedded Revisium engine services against Revo product DB.
11. Verify and apply required Revo template/data migrations through the same serialized migrator used by
    `revisium-migrations apply`.
12. Configure DBOS with the DBOS system database URL.
13. Launch DBOS, letting DBOS apply its own system migrations.
14. Start transport adapters.

Startup MUST fail before step 14 if any required step fails.

### Migration planes

| Plane | Applies to | Trigger | Owner |
| --- | --- | --- | --- |
| Revo Prisma schema migrations | Revo product DB DDL, including engine-required physical tables | host bootstrap / deploy via Prisma Migrate | Revo |
| Revo template/data migrations | virtual project templates, seed data, template ledgers | host bootstrap, `ensureProject`, and `revisium-migrations apply`, all through one serialized migrator | Revo |
| DBOS system migrations | DBOS system DB schema `dbos` | `DBOS.launch()` | DBOS SDK |
| File storage layout | local filesystem keys and metadata | storage bootstrap / lazy writes | Revo |

Revo MUST NOT run DBOS system migrations manually. Revo MAY report the DBOS migration version for diagnostics by
reading `dbos.dbos_migrations` in doctor/status commands.

### Backup and reset

For internal alpha:

- legacy local data is not considered;
- reset means deleting the Revo data directory and recreating storage from scratch;
- no automatic migration from standalone data is required unless a later ADR changes the product stage.

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
- whether engine rows exist for virtual project ids that no longer have a Revo Prisma registry row.

## Validation

Required tests:

- database name resolver rejects invalid identifiers, reserved database names, overlong identifiers, and collisions;
- bootstrap creates both databases idempotently;
- concurrent bootstraps do not fail when both try to create the same database;
- DBOS launch creates `dbos.dbos_migrations` and workflow tables only in the DBOS DB;
- Revo Prisma migration creates `_prisma_migrations` only in the Revo product DB;
- doctor flags DBOS/Revo name collision, engine schema drift, orphaned engine virtual projects, and unexpected DBOS
  tables in Revo DB;
- startup does not serve requests when Revo migrations fail;
- fresh bootstrap works without `@revisium/standalone`, standalone runtime JSON, or standalone HTTP health checks.

## Compatibility

This contract is for the internal alpha target. Existing local data directories may be deleted. No compatibility shim
for old standalone draft rows is required.

## Examples

Default profile:

```text
dataDir: ~/.revisium-orchestrator
postgres database: postgres
revo product database: revo
dbos system database: dbos
```

Dev profile:

```text
dataDir: ~/.revisium-orchestrator-dev
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
