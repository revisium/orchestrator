# Revo docs

Documentation for `@revisium/orchestrator`, the local Revo host.

Revo turns a task into a playbook-driven state machine: agent steps, script steps, human gates, branches, loops,
traceable outputs, and durable run history.

## Read Order

For product and architecture onboarding:

1. [vision.md](./vision.md)
2. [architecture-overview.md](./architecture-overview.md)
3. [developer-guide.md](./developer-guide.md)
4. [specs/README.md](./specs/README.md)
5. [getting-started.md](./getting-started.md)

For implementation work, read the relevant spec before changing the matching source area. ADRs explain why a
direction exists; specs define the exact contract.

## Ownership

- **README** is the public entrypoint: product idea, first commands, and links.
- **Guides** explain current operator or contributor workflows.
- **ADRs** record durable architecture decisions at a high level.
- **Specs** carry exact contracts: types, APIs, schemas, state-machine grammar, validation, examples, and changelog.
- **Work orders** do not live in docs. Track slices, tasks, and delivery plans in GitHub Issues or Revo runs.

There is no internal archive of obsolete plans. Git history is the archive.

## Change Map

| If you change | Read first | Keep in sync |
| --- | --- | --- |
| Pipeline grammar, node kinds, verdicts, loops, branches | [pipeline state machine spec](./specs/pipeline-state-machine-v1.spec.md) | `src/pipeline-core/**`, default playbook pipeline templates |
| Step output production or prompt hydration | [run dataflow spec](./specs/run-dataflow-v1.spec.md) | `src/pipeline-core/validate-dataflow.ts`, `src/pipeline/data-driven-task.workflow.ts`, `src/run/run-outputs.ts` |
| Human approvals, questions, inbox semantics | [human gates spec](./specs/human-gates-v1.spec.md) | `src/pipeline/await-human.ts`, `src/control-plane/inbox.ts`, MCP and GraphQL gate methods |
| GraphQL schema, resolver shape, UI contract | [GraphQL admin API v1 spec](./specs/graphql-admin-api-v1.spec.md) | `src/api/graphql-api/**`, feature API services, schema drift tests |
| MCP tool surface or agent-facing verbs | [getting-started.md](./getting-started.md), [human gates spec](./specs/human-gates-v1.spec.md), [run profiles v1](./specs/run-profiles-v1.spec.md) | `src/mcp/**`, feature API services, MCP capability tests |
| Control-plane tables or ownership classes | [control-plane-schema.md](./control-plane-schema.md) | `control-plane/bootstrap.config.json`, `src/control-plane/**`, `src/revisium/**` |
| Playbook import or built-in playbook catalogs | [architecture-overview.md](./architecture-overview.md), [pipeline state machine spec](./specs/pipeline-state-machine-v1.spec.md), [default playbook policy spec](./specs/default-playbook-policy.spec.md) | `control-plane/default-playbook/**`, `src/playbook/**`, `@revisium/agent-playbook` catalog compatibility |
| Model profiles, run profiles, routing policy, budgets, limits | [control-plane-schema.md](./control-plane-schema.md), [pipeline state machine spec](./specs/pipeline-state-machine-v1.spec.md), [run profiles v1](./specs/run-profiles-v1.spec.md) | `src/control-plane/definitions.ts`, `src/control-plane/run-profiles.ts`, `control-plane/default-playbook/catalog/run-profiles.json`, default playbook policy rows, cost tests |
| Storage bootstrap, Prisma schema, DBOS placement, or embedded engine integration | [ADR-0007](./adr/0007-revo-storage-foundation.md), [storage database layout v1](./specs/storage-database-layout-v1.spec.md), [Revo Prisma and engine schema v1](./specs/revo-prisma-engine-schema-v1.spec.md) | `prisma/schema.prisma`, `src/storage/**`, `src/engine/**`, `src/revisium/**` |
| Revo projects, ADR/KB stores, or template migrations | [ADR-0008](./adr/0008-revo-projects-and-versioned-knowledge.md), [Revo project knowledge and migrations v1](./specs/revo-project-knowledge-migrations-v1.spec.md) | future `src/projects/**`, future `src/revisium-store/**`, future `src/revisium-migrations/**` |
| Runner behavior or external effects | [runner-contract.md](./runner-contract.md) | `src/runners/**`, `src/worker/**`, e2e runner scenarios |
| Context compression or prompt inputs | [context-budget.md](./context-budget.md) | `src/worker/build-context.ts`, run output references, role prompt composition |

## Diagrams

Architecture diagrams live in [assets/](./assets/README.md). Prefer SVG or Mermaid sources for these docs; avoid
generated PNG diagrams unless the asset is genuinely visual and cannot be represented as a diagram.

## Decisions

| ADR | Decision |
| --- | --- |
| [ADR-0001](./adr/0001-execution-engine-and-host.md) | DBOS durable engine and NestJS host |
| [ADR-0002](./adr/0002-data-driven-pipeline-state-machine.md) | Pipeline-as-data engine |
| [ADR-0003](./adr/0003-graphql-graph-shape.md) | GraphQL admin API graph-shaped contract |
| [ADR-0004](./adr/0004-runner-execution-contract.md) | Runner execution contract |
| [ADR-0005](./adr/0005-versioned-playbook-storage-and-revo-materialization.md) | Versioned playbook storage and Revo materialization |
| [ADR-0006](./adr/0006-run-profiles-and-provider-neutral-pipelines.md) | Run profiles and provider-neutral feature-development |
| [ADR-0007](./adr/0007-revo-storage-foundation.md) | Revo storage foundation |
| [ADR-0008](./adr/0008-revo-projects-and-versioned-knowledge.md) | Revo projects and versioned knowledge |

## Specs

| Spec | Contract |
| --- | --- |
| [GraphQL admin API v1](./specs/graphql-admin-api-v1.spec.md) | Local GraphQL admin API transport, graph contract, compatibility, and verification |
| [Pipeline state machine v1](./specs/pipeline-state-machine-v1.spec.md) | Template grammar, reducer, validation, versioning |
| [Run dataflow v1](./specs/run-dataflow-v1.spec.md) | Step outputs, prompt hydration, output storage, validation |
| [Human gates v1](./specs/human-gates-v1.spec.md) | Inbox-backed gates, questions, watch tools, PR review feedback loop |
| [Default playbook policy](./specs/default-playbook-policy.spec.md) | Bundled `feature-development` policy rules, static verifier scope, and merge-gate recheck behavior |
| [Run profiles v1](./specs/run-profiles-v1.spec.md) | Draft run-profile contract for provider-neutral `feature-development`, profile-driven topology/bindings, MCP ergonomics, and replay pins |
| [Storage database layout v1](./specs/storage-database-layout-v1.spec.md) | Draft storage v2 topology, database ownership, bootstrap order, and migration planes |
| [Revo Prisma and engine schema v1](./specs/revo-prisma-engine-schema-v1.spec.md) | Draft Revo product DB schema ownership and embedded engine table compatibility |
| [Revo project knowledge and migrations v1](./specs/revo-project-knowledge-migrations-v1.spec.md) | Draft Revo project ADR/KB table initialization and engine migration contract |

## Guides and References

| Doc | Purpose |
| --- | --- |
| [vision.md](./vision.md) | Product direction, capability map, and glossary |
| [architecture-overview.md](./architecture-overview.md) | Runtime layers, invariants, and lifecycle |
| [developer-guide.md](./developer-guide.md) | Source map and contributor onboarding |
| [getting-started.md](./getting-started.md) | Local daemon, MCP, and GraphQL workflow |
| [control-plane-schema.md](./control-plane-schema.md) | Revisium table ownership and row classes |
| [repo-layer-contract.md](./repo-layer-contract.md) | Current Revisium data-access boundary |
| [runner-contract.md](./runner-contract.md) | Runner boundary and external-effect rules |
| [context-budget.md](./context-budget.md) | Prompt context shape and token discipline |
