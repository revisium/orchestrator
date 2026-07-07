# Revo data-access contract

Product services hide storage details from transport adapters. MCP and GraphQL call product services; product services
call Revisium meaning access for versioned control-plane rows and Prisma-backed services for runtime rows.

## Boundary

- Versioned meaning reads use committed `head`.
- Runtime writes use Prisma transactions and are never committed as Revisium revisions.
- DBOS progress is accessed through the engine adapter, not through Revisium tables.
- Consumers receive domain objects, not raw Revisium or Prisma payloads.

## Meaning reads

- `loadRole` and role listing read committed role definitions.
- `loadPipeline` and pipeline listing read committed pipeline definitions.
- `loadPlaybook` and playbook listing read committed playbook metadata.
- `listRunProfiles` and `resolveRunProfile` read committed run profile definitions.
- `loadModelProfile` reads committed model profile mapping.
- Routing policy reads committed policy rows.

## Runtime writes and reads

- Runs and tasks are Prisma runtime rows.
- Events are append-only Prisma rows.
- Inbox items are Prisma rows that represent human decisions.
- Attempts and costs are Prisma runtime provenance/accounting.
- Run outputs are Prisma runtime data used for step-to-step dataflow.

## Revision rules

- Installing or updating playbook/role/pipeline/model meaning creates committed revisions.
- Creating runs, resolving gates, appending events, recording costs, and recording outputs never create committed
  revisions.
- Runtime row writes must be idempotent where DBOS replay can repeat a side effect.

## Transport adapters

MCP and GraphQL must remain thin:

- no raw Revisium table access;
- no raw Prisma model access from transports;
- no DBOS table access;
- no duplicate lifecycle logic;
- stable error mapping at the service/transport boundary.

Exact table ownership is documented in [control-plane-schema.md](./control-plane-schema.md). Run dataflow storage
is specified in [specs/run-dataflow-v1.spec.md](./specs/run-dataflow-v1.spec.md).
