# Revisium data-access contract

The Revisium data-access layer is the only code that should know control-plane table shapes. Transport adapters
such as MCP and GraphQL call product services; product services call this layer.

## Boundary

- Versioned meaning reads use committed `head`.
- Runtime writes use draft and are never committed.
- DBOS progress is accessed through the engine adapter, not through Revisium tables.
- Consumers receive domain objects, not raw Revisium row payloads.

## Meaning reads

- `loadRole` and role listing read committed role definitions.
- `loadPipeline` and pipeline listing read committed pipeline definitions.
- `loadPlaybook` and playbook listing read committed playbook metadata.
- `loadModelProfile` reads committed model profile mapping.
- Routing policy reads committed policy rows.

## Runtime writes and reads

- Runs and tasks are runtime projections in draft.
- Events are append-only draft rows.
- Inbox items are draft rows that represent human decisions.
- Attempts and costs are runtime provenance/accounting.
- Run outputs are runtime draft data used for step-to-step dataflow.

## Revision rules

- Installing or updating playbook/role/pipeline/model meaning creates committed revisions.
- Creating runs, resolving gates, appending events, recording costs, and recording outputs never create committed
  revisions.
- Runtime row writes must be idempotent where DBOS replay can repeat a side effect.

## Transport adapters

MCP and GraphQL must remain thin:

- no raw Revisium table access;
- no DBOS table access;
- no duplicate lifecycle logic;
- stable error mapping at the service/transport boundary.

Exact table ownership is documented in [control-plane-schema.md](./control-plane-schema.md). Run dataflow storage
is specified in [specs/run-dataflow-v1.spec.md](./specs/run-dataflow-v1.spec.md).
