# ADR-0001 - Execution engine and host framework

- **Status:** Accepted
- **Decision date:** 2026-05
- **Supersedes:** the earlier hand-rolled loop runtime
- **Amended-by:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md) (data-driven pipeline state machine)
- **Specs:** [pipeline state machine](../specs/pipeline-state-machine-v1.spec.md),
  [human gates](../specs/human-gates-v1.spec.md)

## Context

The orchestrator needs to run software-development tasks across crashes, retries, human pauses, and concurrent
front doors. Reimplementing durable workflow semantics with custom leases, recovery, retry, and queue logic would
make Revisium carry progress concerns it is not meant to own.

The product also needs one host process that can expose local CLI lifecycle, MCP tools, GraphQL, runners, and
future adapters over one set of product services.

## Decision

Use **DBOS** as the durable execution engine and **NestJS** as the host framework.

DBOS owns execution progress: workflow checkpoints, queues, retries, sleeps, and waits for human decisions. It is
an in-process TypeScript library backed by Postgres, so it fits the local-first package model better than a
separate runtime service.

NestJS owns host composition: dependency injection, lifecycle hooks, and front-door modules for MCP, GraphQL, and
CLI lifecycle commands. The host talks to Revisium for meaning and projections, and to DBOS for progress.

Revisium remains the source of truth for meaning: roles, playbooks, pipeline definitions, inbox rows, events,
costs, and domain data. DBOS remains the source of truth for progress.

The original choice proved DBOS with a short-lived MVP coded workflow. The current pipeline engine is data-driven;
ADR-0002 records that amendment.

## Examples

- Starting or reattaching a run uses the run id as the durable workflow identity.
- A human gate writes an inbox row in Revisium and parks the DBOS workflow until the inbox row is resolved.
- MCP and GraphQL delegate through product API services instead of owning separate runtime behavior.

## Alternatives

- **Hand-rolled Revisium queue:** rejected because leases, atomic claims, recovery, and retries are durable-engine
  concerns.
- **Temporal:** mature but too heavy for a local package-first runtime.
- **Restate:** capable, but adds a separate runtime binary to install and manage.
- **Ad hoc scripts without a host:** rejected because multiple front doors need one shared service boundary.

## Consequences

- Durable progress must not be stored in local files or process memory.
- DBOS internals must stay behind the host engine boundary; product code should not query DBOS tables directly.
- Revisium runtime rows remain draft data; versioned meaning is committed separately.
- A future engine swap is possible only if DBOS-specific behavior stays inside the engine adapter.
- Host lifecycle work belongs in NestJS modules, not scattered CLI command code.
