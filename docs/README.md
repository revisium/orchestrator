# agent-orchestrator docs

Documentation for the Revo host and local orchestrator.

## Ownership

- **ADRs** record durable decisions at a high level: context, decision, examples, alternatives, consequences, and
  links to specs.
- **Specs** carry exact contracts: types, APIs, schemas, state-machine grammar, validation, examples, and
  changelog.
- **Guides** explain current operator or contributor workflows.
- **Work orders** do not live in docs. Track slices, tasks, and delivery plans in GitHub Issues or Revo runs.

There is no internal archive of obsolete plans. Git history is the archive.

## Read order

1. [architecture-overview.md](./architecture-overview.md)
2. [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md)
3. [adr/0002-data-driven-pipeline-state-machine.md](./adr/0002-data-driven-pipeline-state-machine.md)
4. [specs/README.md](./specs/README.md)
5. [getting-started.md](./getting-started.md)

## Decisions

| ADR | Decision |
| --- | --- |
| [ADR-0001](./adr/0001-execution-engine-and-host.md) | DBOS durable engine and NestJS host |
| [ADR-0002](./adr/0002-data-driven-pipeline-state-machine.md) | Pipeline-as-data engine |
| [ADR-0003](./adr/0003-graphql-graph-shape.md) | GraphQL admin API graph-shaped contract |

## Specs

| Spec | Contract |
| --- | --- |
| [GraphQL admin API v1](./specs/graphql-admin-api-v1.spec.md) | Local GraphQL admin API transport, graph contract, compatibility, and verification |
| [Pipeline state machine v1](./specs/pipeline-state-machine-v1.spec.md) | Template grammar, reducer, validation, versioning |
| [Run dataflow v1](./specs/run-dataflow-v1.spec.md) | Step outputs, prompt hydration, output storage, validation |
| [Human gates v1](./specs/human-gates-v1.spec.md) | Inbox-backed gates, questions, watch tools, PR review feedback loop |

## Guides and references

| Doc | Purpose |
| --- | --- |
| [vision](./vision.md) | Product direction and glossary |
| [architecture overview](./architecture-overview.md) | Runtime layers and invariants |
| [getting started](./getting-started.md) | Local daemon, MCP, and GraphQL workflow |
| [control-plane schema](./control-plane-schema.md) | Revisium table ownership and row classes |
| [repo-layer contract](./repo-layer-contract.md) | Current Revisium data-access boundary |
| [runner contract](./runner-contract.md) | Runner boundary and external-effect rules |
| [context budget](./context-budget.md) | Prompt context shape and token discipline |
