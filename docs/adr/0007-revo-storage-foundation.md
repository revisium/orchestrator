# ADR-0007 - Revo storage foundation

- **Status:** Draft
- **Decision date:** 2026-07-06
- **Implementation status:** The Revo-owned embedded PostgreSQL path, Prisma runtime models, engine-required tables,
  separate DBOS database, and in-process engine integration have substantially landed. Acceptance and remaining
  storage/knowledge contracts are still open.
- **Specs:** [storage database layout v1](../specs/storage-database-layout-v1.spec.md),
  [Revo Prisma and engine schema v1](../specs/revo-prisma-engine-schema-v1.spec.md),
  [run dataflow v1](../specs/run-dataflow-v1.spec.md),
  [human gates v1](../specs/human-gates-v1.spec.md)
- **Relates-to:** [ADR-0001](./0001-execution-engine-and-host.md),
  [ADR-0002](./0002-data-driven-pipeline-state-machine.md)

## Context

The original host used an external local storage daemon and placed hot run projections in Revisium draft tables.
That model made transactional run/gate behavior, lifecycle ownership, and recovery reconciliation harder while DBOS
already owned durable workflow progress.

Revo needs first-class SQL product/runtime facts such as projects, runs, tasks, attempts, inbox items, events,
outputs, costs, and indexes. It also needs the embedded Revisium engine for committed/versioned meaning and DBOS for
workflow progress. These lifecycles require distinct owners even when they share one local PostgreSQL cluster.

Revo is an internal alpha. This redesign has no requirement to preserve pre-v2 local data or transitional authority
models.

## Draft Decision

Use one Revo-owned embedded PostgreSQL cluster with two logical databases:

| Database | Logical owner | Contents |
| --- | --- | --- |
| Revo product DB | Revo Prisma + embedded Revisium engine | Revo product/runtime models plus engine-required physical tables |
| DBOS system DB | DBOS SDK, provisioned by Revo | DBOS workflow, queue, wait, event, and migration tables |

Revo Prisma owns hot product/runtime facts. The embedded Revisium engine owns branch/revision/table meaning and
committed/versioned control-plane or project knowledge. DBOS owns workflow progress and its own DDL. Git, worktrees,
and files remain the authority for source changes and large artifacts.

The Revo host starts the embedded database, provisions both logical databases, applies Revo Prisma migrations,
initializes the engine/control-plane store, launches DBOS, and serves front doors only after every required plane is
ready. Product code uses the public Prisma/engine/DBOS service boundaries and does not query DBOS tables directly.

The Revo product database includes engine-required physical tables because the embedded engine needs them, but their
presence does not make hot Prisma run rows versioned Revisium meaning. Logical ownership follows the API and mutation
lifecycle, not table colocation.

`RevoProject` is a Prisma product entity. The engine receives its id as an opaque project grouping key; it does not
own project lifecycle. Exact project/ADR/KB meaning remains Draft under ADR-0008.

## Current and Target Boundary

The current Prisma schema confirms the hot runtime split: `RevoProject`, `TaskRun`, `RunTask`, `RunEvent`,
`RunAttempt`, `InboxItem`, `RunOutput`, and `CostLedgerEntry` are Prisma-owned. No first-class `Repository` model is
shipped; repository refs currently live on run/task data.

The embedded engine physical models and separate DBOS database are also current implementation. ADR/KB tables,
proposal/acceptance flows, large attachment lifecycle, and the complete playbook/execution-plan storage target remain
Draft. This partial landing does not automatically accept the ADR.

## Direct Cutover

The target does not support legacy draft runtime rows, external-daemon fallback, dual-write old/new stores, migration
shims for internal alpha data, or DBOS tables in the Revo product database. Resetting the local alpha data directory is
the migration path until a separately approved compatibility requirement exists.

## Alternatives

- **Keep hot runtime facts in Revisium drafts.** Rejected because transactional status/gate semantics and retention are
  runtime concerns, not accepted versioned meaning.
- **Keep an external storage daemon.** Rejected because it adds a second daemon and HTTP boundary to a local in-process
  product path.
- **Use separate engine and Revo runtime databases.** Rejected because Revo owns one product schema and project
  identity, while cross-database coordination adds no useful authority boundary.
- **Put DBOS tables in the product database.** Rejected because DBOS independently owns and migrates its schema.
- **Model Revo projects as Revisium rows.** Rejected because project lifecycle, relations, and API scoping are
  Prisma-owned product concerns.

## Consequences

- Revo owns database bootstrap and readiness ordering; Prisma and DBOS retain their migration ownership.
- The engine package/schema integration is a pinned build input with drift verification.
- MCP and GraphQL remain thin over application services regardless of physical table location.
- Runtime retention and indexing can evolve without producing Revisium revisions.
- Accepted ADR/KB and playbook meaning can use engine revisions without absorbing hot run facts.
- Exact database names, engine model compatibility, bootstrap mechanics, migrations, and verification matrices remain
  in the linked Draft specs.
