# Revo data-access contract

This page describes the **Current shipped behavior** product-service boundary, then identifies the **Draft target** for pinned
execution. It does not define storage schemas.

Product services hide storage details from transport adapters. MCP and GraphQL call product services; product services
call Revisium meaning access for versioned control-plane rows and Prisma-backed services for runtime rows.

## Boundary

- Current authoring, discovery, and route-time meaning reads use committed `head`.
- Runtime writes use Prisma transactions and are never committed as Revisium revisions.
- DBOS progress is accessed through the engine adapter, not through Revisium tables.
- Git/worktree operations are accessed through bounded repository/effect adapters, not through storage services.
- Consumers receive domain objects, not raw Revisium or Prisma payloads.

## Meaning reads

- `loadRole` and role listing read committed role definitions.
- `loadPipeline` and pipeline listing read committed pipeline definitions.
- `loadPlaybook` and playbook listing read committed playbook metadata.
- `listRunProfiles` and `resolveRunProfile` read committed run profile definitions.
- `loadModelProfile` reads committed model profile mapping.
- Routing policy reads committed policy rows.

Current run creation pins a materialized template/profile decision in Prisma. Role/model and other meaning reads are
not yet unified into the full Draft `ExecutionPlan`.

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

Different wire contracts are allowed, but MCP and GraphQL must delegate the same product command/query rather than
reimplement its state transition. A future UI remains a projection/editor over these application services.

## Draft Execution Boundary

The Draft [execution plan](./specs/execution-plan-v1.spec.md) contract changes execution-time reads: route planning
fully resolves and pins execution-affecting playbook, role, runner, script, policy, resource, context, and accepted
knowledge inputs. Workflow execution/recovery consumes that pin and must not re-read mutable Revisium `head`, a source
checkout, or a live registry.

The Draft [script runtime](./specs/script-runtime-v1.spec.md) and
[resources/workspaces/effects](./specs/resources-workspaces-effects-v1.spec.md) specs own bounded external operations
and repository/worktree lifecycle. Scripts return typed results; application routing remains in `pipeline-core`.

Exact table ownership is documented in [control-plane-schema.md](./control-plane-schema.md). Run dataflow storage
is specified in [specs/run-dataflow-v1.spec.md](./specs/run-dataflow-v1.spec.md).
