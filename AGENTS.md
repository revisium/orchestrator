# AGENTS.md - agent-orchestrator

Repo-local context for coding agents. `CLAUDE.md` is a symlink to this file.

## Method vs. context

Reusable method lives in the sibling `../agents` checkout. This repository keeps product context, source code,
ADRs, and specs. Do not copy canonical roles or pipelines into this repo's docs.

## What this is

`agent-orchestrator` is the Revo host: a NestJS application that runs short-lived AI-agent steps through DBOS and
stores product meaning in Revisium.

- **DBOS owns progress:** durable workflow cursor, retries, waits, and resume.
- **Revisium owns meaning:** playbooks, roles, pipeline templates, inbox rows, events, costs, and projections.
- **MCP is the agent front door:** local stdio bridge over product tools.
- **GraphQL is the UI/script front door:** local NestJS/Yoga endpoint over the same feature services.
- **CLI is lifecycle-first:** start, stop, status, restart, doctor, logs, and the MCP bridge.

Read [docs/architecture-overview.md](./docs/architecture-overview.md) and the specs in
[docs/specs/](./docs/specs/) before changing runtime contracts.

## Local facts

- Node: `>=24.11.1 <25`.
- Stack: TypeScript, NestJS 11, DBOS, local Revisium standalone, GraphQL Yoga, local stdio MCP.
- Default profile ports: Revisium HTTP `19222`, embedded Postgres `15440`, GraphQL `19223`.
- Dev profile ports: Revisium HTTP `19622`, embedded Postgres `15840`, GraphQL `19623`.
- The resolved runtime state lives under the selected Revo data directory. Do not hardcode resolved ports in code.
- Source-of-truth schema reference: [docs/control-plane-schema.md](./docs/control-plane-schema.md).

## Docs map

- [docs/README.md](./docs/README.md) - docs index and ownership policy.
- [docs/architecture-overview.md](./docs/architecture-overview.md) - invariants and runtime shape.
- [docs/adr/](./docs/adr/) - high-level decision records.
- [docs/specs/](./docs/specs/) - exact durable contracts.
- [docs/getting-started.md](./docs/getting-started.md) - local operator flow.

There is no canonical docs archive of obsolete work orders. Work orders belong in GitHub Issues or Revo runs; use
git history for old task text.

## Editing rules

- Inspect current source before changing docs that describe runtime behavior.
- Keep ADRs concise; move exact schemas, APIs, validation rules, and examples to specs.
- Do not describe GraphQL graph-shape migration as landed until the full v1 contract is implemented and
  legacy flat/run-scoped roots are removed from `src/api/graphql-api/schema.graphql`.
- Do not edit source code for a docs cleanup unless a generated docs link truly requires it; stop and report
  first.
- `revo-plans` is read-only source material for this cleanup.
