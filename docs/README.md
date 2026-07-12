# Revo docs

Documentation for `@revisium/orchestrator`, the local Revo host and control plane.

Revo keeps deterministic algorithms and human gates in authority while short-lived AI workers propose and execute
software-development work. The first wedge takes a task through an approved plan, an independently reviewed change,
observed pull-request feedback, and a human-approved merge.

Documents must label claims as **Current shipped behavior**, **Accepted target**, **Draft target**, or **Later** when
the distinction matters. Implementation presence alone does not make a Draft decision Accepted.

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
| Pipeline grammar, node kinds, verdicts, loops, branches | [pipeline state machine spec](./specs/pipeline-state-machine-v1.spec.md) | `src/pipeline-core/**`, built-in default playbook graph |
| Installed playbook versions, resolved run pins, or replay inputs | [playbook storage v1](./specs/playbook-storage-v1.spec.md), [execution plan v1](./specs/execution-plan-v1.spec.md) | `src/playbook/**`, `src/execution-plan/**`, route creation, `TaskRun.executionPlan` |
| Step output production or prompt hydration | [run dataflow spec](./specs/run-dataflow-v1.spec.md) | `src/pipeline-core/validate-dataflow.ts`, `src/pipeline/data-driven-task.workflow.ts`, `src/run/run-outputs.ts` |
| Human approvals, questions, inbox semantics | [human gates spec](./specs/human-gates-v1.spec.md) | `src/pipeline/await-human.ts`, `src/control-plane/inbox.ts`, MCP and GraphQL gate methods |
| GraphQL schema, resolver shape, UI contract | [GraphQL admin API v1 spec](./specs/graphql-admin-api-v1.spec.md) | `src/api/graphql-api/**`, feature API services, schema drift tests |
| MCP tool surface or agent-facing verbs | [getting-started.md](./getting-started.md), [human gates spec](./specs/human-gates-v1.spec.md), [run profiles v1](./specs/run-profiles-v1.spec.md) | `src/mcp/**`, feature API services, MCP capability tests |
| Control-plane tables or ownership classes | [control-plane-schema.md](./control-plane-schema.md) | `control-plane/bootstrap.config.json`, `src/control-plane/**`, `src/revisium/**` |
| Playbook authoring/import or built-in bootstrap data | [architecture-overview.md](./architecture-overview.md), [playbook storage v1](./specs/playbook-storage-v1.spec.md), [execution plan v1](./specs/execution-plan-v1.spec.md) | `control-plane/default-playbook/**`, `src/playbook/**`, `@revisium/agent-playbook` authoring contract |
| Model profiles, run profiles, routing policy, budgets, limits | [control-plane-schema.md](./control-plane-schema.md), [pipeline state machine spec](./specs/pipeline-state-machine-v1.spec.md), [run profiles v1](./specs/run-profiles-v1.spec.md) | `src/control-plane/definitions.ts`, `src/control-plane/run-profiles.ts`, `control-plane/default-playbook/catalog/run-profiles.json`, default playbook policy rows, cost tests |
| Pipeline coverage strategy, DSL e2e cases, graph coverage, or hard skips | [pipeline test coverage v1](./specs/pipeline-test-coverage-v1.spec.md), [default playbook policy spec](./specs/default-playbook-policy.spec.md) | `src/e2e/support/pipeline-context.ts`, `src/e2e/pipeline/**`, `src/testing/policy/pipeline-coverage.ts`, `VERIFICATION.md` |
| Test-layer boundaries, surface contexts, coverage evidence, semantic snapshots, or test timing | [test architecture v1](./specs/test-architecture-v1.spec.md), [current test coverage matrix](./specs/test-coverage-matrix-v1.json), [pipeline test coverage v1](./specs/pipeline-test-coverage-v1.spec.md) | `src/e2e/**`, `src/testing/policy/**`, `eslint-local-rules/test-architecture-boundaries.js`, `package.json`, `.github/workflows/ci.yml` |
| Storage bootstrap, Prisma schema, DBOS placement, or embedded engine integration | [ADR-0007](./adr/0007-revo-storage-foundation.md), [storage database layout v1](./specs/storage-database-layout-v1.spec.md), [Revo Prisma and engine schema v1](./specs/revo-prisma-engine-schema-v1.spec.md) | `prisma/schema.prisma`, `src/storage/**`, `src/engine/**`, `src/revisium/**` |
| Revo projects, ADR/KB stores, or template migrations | [ADR-0008](./adr/0008-revo-projects-and-versioned-knowledge.md), [Revo project knowledge and migrations v1](./specs/revo-project-knowledge-migrations-v1.spec.md) | `prisma/schema.prisma`, engine-backed project services as they land, project/knowledge tests |
| Agent runner behavior | [runner-contract.md](./runner-contract.md) | `src/runners/**`, `src/worker/**`, e2e runner scenarios |
| Script/effect registration or execution | [script runtime v1](./specs/script-runtime-v1.spec.md) | Current: `src/pipeline/data-driven-task.workflow.ts`, `src/runners/integrator.ts`; Draft target: `src/system-scripts/**`, pipeline script refs, runtime effect adapter |
| Repository, worktree, or resource lifecycle | [resources, workspaces, and effects v1](./specs/resources-workspaces-effects-v1.spec.md) | Current: `src/worker/git-worktree-manager.ts`; Draft target: `src/run-resources/**`, `src/workspaces/**`, pipeline declarations, artifact refs |
| Context compression or prompt inputs | [context-budget.md](./context-budget.md) | `src/worker/build-context.ts`, run output references, role prompt composition |

## Diagrams

Architecture diagrams live in [assets/](./assets/README.md). Prefer SVG or Mermaid sources for these docs; avoid
generated PNG diagrams unless the asset is genuinely visual and cannot be represented as a diagram.

## Decisions

| ADR | Status | Decision |
| --- | --- | --- |
| [ADR-0001](./adr/0001-execution-engine-and-host.md) | Accepted | DBOS durable engine and NestJS host |
| [ADR-0002](./adr/0002-data-driven-pipeline-state-machine.md) | Accepted | Pipeline-as-data engine |
| [ADR-0003](./adr/0003-graphql-graph-shape.md) | Accepted | GraphQL admin API graph-shaped contract |
| [ADR-0004](./adr/0004-runner-execution-contract.md) | Draft | Runner execution contract |
| [ADR-0005](./adr/0005-versioned-playbook-storage-and-revo-materialization.md) | Draft | Versioned playbook storage, execution-plan input, and Revo materialization |
| [ADR-0006](./adr/0006-run-profiles-and-provider-neutral-pipelines.md) | Draft | Run profiles and provider-neutral feature-development |
| [ADR-0007](./adr/0007-revo-storage-foundation.md) | Draft | Revo storage foundation; substantial storage implementation has landed |
| [ADR-0008](./adr/0008-revo-projects-and-versioned-knowledge.md) | Draft | Revo projects and versioned knowledge |
| [ADR-0009](./adr/0009-test-architecture-boundaries.md) | Accepted | Test-layer, context, and evidence-ownership boundaries |
| [ADR-0010](./adr/0010-run-resources-and-workspace-planning.md) | Draft | Named run resources, isolated workspaces, and immutable execution-plan compilation |
| [ADR-0011](./adr/0011-system-script-runtime-and-trusted-extensions.md) | Draft | Bounded script definitions, explicit registration, and trusted startup extensions |

ADR-0001 and ADR-0002 are immutable historical decisions. Their Revisium runtime-storage descriptions do not reflect
shipped ownership; current facts live in [control-plane-schema.md](./control-plane-schema.md) and
[repo-layer-contract.md](./repo-layer-contract.md). ADR-0007 proposes an amendment but remains Draft; the Accepted
records stay unchanged unless that decision is accepted.

## Specs

| Spec | Contract |
| --- | --- |
| [GraphQL admin API v1](./specs/graphql-admin-api-v1.spec.md) | Local GraphQL admin API transport, graph contract, compatibility, and verification |
| [Pipeline state machine v1](./specs/pipeline-state-machine-v1.spec.md) | Template grammar, reducer, validation, versioning |
| [Execution plan v1](./specs/execution-plan-v1.spec.md) | Draft nested route plus resolved task/resource/workspace/node/script/input/credential pins, canonical hash, persistence, and enqueue fence |
| [Script runtime v1](./specs/script-runtime-v1.spec.md) | Draft `defineScript`, sealed registry, bounded operations, reconciliation, and contract test kit |
| [Resources, workspaces, and effects v1](./specs/resources-workspaces-effects-v1.spec.md) | Draft portable resources, resolved workspace plans, lifecycle, capability intersection, and artifact boundary |
| [Run dataflow v1](./specs/run-dataflow-v1.spec.md) | Step outputs, prompt hydration, output storage, validation |
| [Human gates v1](./specs/human-gates-v1.spec.md) | Inbox-backed gates, questions, watch tools, PR review feedback loop |
| [Default playbook policy](./specs/default-playbook-policy.spec.md) | Bundled `feature-development` policy rules, static verifier scope, and merge-gate recheck behavior |
| [Pipeline test coverage v1](./specs/pipeline-test-coverage-v1.spec.md) | Test-layer ownership, DSL coverage matrix policy, profile coverage, and hard-skip rules |
| [Test architecture v1](./specs/test-architecture-v1.spec.md) | Accepted target layer/context boundaries, runtime-evidence requirements, matrix ownership, migration, and CI constraints |
| [Run profiles v1](./specs/run-profiles-v1.spec.md) | Draft run-profile contract for provider-neutral `feature-development`, profile-driven topology/bindings, MCP ergonomics, and replay pins |
| [Storage database layout v1](./specs/storage-database-layout-v1.spec.md) | Draft storage v2 topology, database ownership, bootstrap order, and migration planes |
| [Revo Prisma and engine schema v1](./specs/revo-prisma-engine-schema-v1.spec.md) | Draft Revo product DB schema ownership and embedded engine table compatibility |
| [Revo project knowledge and migrations v1](./specs/revo-project-knowledge-migrations-v1.spec.md) | Draft Revo project ADR/KB table initialization and engine migration contract |

## Current-state snapshots

| Snapshot | Purpose |
| --- | --- |
| [Test coverage matrix v1](./specs/test-coverage-matrix-v1.json) | Stage 2 working-tree evidence and Stage 1 performance baseline; documentation-owned, not the executable registry |

## Guides and References

| Doc | Purpose |
| --- | --- |
| [vision.md](./vision.md) | Product direction, capability map, and glossary |
| [architecture-overview.md](./architecture-overview.md) | Runtime layers, invariants, and lifecycle |
| [developer-guide.md](./developer-guide.md) | Source map and contributor onboarding |
| [getting-started.md](./getting-started.md) | Local daemon, MCP, and GraphQL workflow |
| [control-plane-schema.md](./control-plane-schema.md) | Current DBOS, Prisma, Revisium, and file ownership |
| [repo-layer-contract.md](./repo-layer-contract.md) | Product-service and storage-access boundary |
| [runner-contract.md](./runner-contract.md) | Agent-runner boundary and relation to script/effect execution |
| [context-budget.md](./context-budget.md) | Prompt context shape and token discipline |
