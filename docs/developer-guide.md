# Developer guide

This guide is the source map for new contributors and coding agents. It does not replace specs or ADRs; it points
to the files that own each behavior.

## Mental Model

Revo is a deterministic control plane over short-lived, probabilistic workers. It has four implementation layers:

1. **Product contracts:** playbooks, roles, pipeline graphs, script/effect capabilities, GraphQL/MCP operations, and
   human gates.
2. **Runtime engine:** pure state-machine interpretation plus a durable workflow adapter.
3. **State boundary:** Revo Prisma stores product/runtime state, the embedded Revisium engine stores versioned
   control-plane meaning/config, and DBOS stores authoritative progress.
4. **Execution boundary:** short-lived agents and bounded external operations run in declared workspaces and return
   recorded results. Neither owns routing.

Use the spec for the contract, then inspect the source owner before editing.

Status matters: current code is implementation truth; Accepted ADR/spec targets are approved direction; Draft targets
remain proposals even when parts have landed. The current built-in executable graph is product bootstrap data. The
canonical `agent-playbook` catalogs are metadata and are not yet a runnable end-to-end Revo package.

## Source Map

| Area | Owner files | Notes |
| --- | --- | --- |
| CLI lifecycle | `src/cli/**`, `src/host/**` | `revo start`, `stop`, `status`, `restart`, `doctor`, `logs`, and `mcp` bridge |
| Host composition | `src/http/graphql-host.module.ts`, `src/host/**`, `src/http/**` | NestJS daemon, GraphQL host, MCP HTTP bridge, daemon runtime files |
| Feature API services | `src/features/**`, `src/task-control-plane/**` | Product-level services used by GraphQL and MCP |
| GraphQL front door | `src/api/graphql-api/**`, `src/http/graphql-host.ts` | Resolver and SDL contract; keep drift tests green |
| MCP front door | `src/mcp/**` | Local agent tool surface; do not expose raw Revisium CRUD |
| Pipeline core | `src/pipeline-core/**` | Pure state-machine interpreter and validators; no I/O, clocks, runners, or DBOS imports |
| Durable adapter | `src/pipeline/**`, `src/engine/**` | DBOS workflow adapter, human waits, run progression, replay-safe side effects |
| Control-plane data | `control-plane/bootstrap.config.json`, `src/control-plane/**`, `src/revisium/**` | Embedded engine schema, data access, versioned meaning |
| Playbook import | `control-plane/default-playbook/**`, `src/playbook/**` | Current product bootstrap graph plus catalog import/install logic; Draft full-package compiler |
| Runner boundary | `src/runners/**`, `src/worker/**` | Short-lived agent execution, context build, artifact logs, result envelopes |
| Script/effect shell | `src/pipeline/data-driven-task.workflow.ts`, script handlers under runner/worker services | Current named product effects; Draft versioned bounded-operation registry |
| Repository/workspace resources | `src/worker/git-worktree-manager.ts`, integration/PR handlers | Current worktree and Git/GitHub lifecycle; Draft explicit resource ownership |
| Observability and PR feedback | `src/observability/**`, `src/poller/**`, `src/features/pr/**` | Attempt streams, logs, PR readiness, review feedback triage |
| E2E harness | `src/e2e/**`, `scripts/e2e-setup.ts` | Real DBOS/embedded engine scenarios and MCP/GraphQL smoke behavior |

## Change Rules

- Keep transport adapters thin. GraphQL and MCP call feature services; they do not read DBOS tables or raw engine rows.
- Keep `pipeline-core` pure. Validation and interpretation must stay deterministic and testable without the host.
- Keep authority out of workers. Agents and scripts return results; the graph/reducer advances the cursor and humans
  resolve declared gates.
- Keep runtime rows in Prisma. Creating runs, resolving gates, recording attempts, appending events, and recording costs
  must not create committed engine revisions.
- Treat external effects as externally dependent operations. Keep them bounded and idempotent by run, node, and
  attempt identity because the current DBOS adapter registers steps without a retry policy, and DBOS replay may
  re-execute an in-flight step before its checkpoint. Retry remains a separate valid effect/runner mechanism; this does
  not imply that completed checkpointed effects replay. Deterministic routing consumes their recorded typed result.
- Keep code and diffs in git. Revo payloads store summaries, evidence, and artifact refs, not full repository
  snapshots.
- Keep docs and contracts in the same PR as behavior changes. Specs get exact contract changes; guides get workflow
  changes; ADRs get durable decision changes.

## Common Tasks

| Task | Start here | Verification focus |
| --- | --- | --- |
| Add or change a pipeline node kind | `docs/specs/pipeline-state-machine-v1.spec.md`, `src/pipeline-core/types.ts` | Validator tests, interpreter tests, default template compatibility |
| Change data passed between steps | `docs/specs/run-dataflow-v1.spec.md`, `src/pipeline-core/validate-dataflow.ts` | Produce/consume validation, adapter hydration, replay ordinals |
| Change approval or question behavior | `docs/specs/human-gates-v1.spec.md`, `src/pipeline/await-human.ts` | Inbox writes, idempotent resolution, parked workflow resume |
| Change GraphQL fields | `docs/specs/graphql-admin-api-v1.spec.md`, `src/api/graphql-api/**` | SDL drift tests, resolver tests, feature service delegation |
| Add an MCP tool | `src/mcp/mcp-tools.ts`, matching feature service | Tool schema, thin facade behavior, no raw table CRUD |
| Change built-in playbooks or import mapping | `control-plane/default-playbook/**`, `src/playbook/**` | Catalog compatibility, route gates, default template validation |
| Change installed playbook/run pinning | `docs/specs/playbook-storage-v1.spec.md`, `docs/specs/execution-plan-v1.spec.md` | Immutable version identity, full resolution, no recovery-time mutable reads |
| Change routing policy, budgets, or model profiles | `docs/control-plane-schema.md`, `src/control-plane/definitions.ts` | Policy parsing, fail-safe defaults, cost and iteration-limit behavior |
| Add agent runner capability | `docs/runner-contract.md`, `src/runners/**`, `src/worker/**` | Result envelope, artifact refs, permission boundaries, replay safety |
| Add/change a script or external effect | `docs/specs/script-runtime-v1.spec.md`, `docs/specs/resources-workspaces-effects-v1.spec.md` | Typed schemas, permissions/resources, idempotency, redaction, no routing ownership |
| Change repository/worktree lifecycle | `docs/specs/resources-workspaces-effects-v1.spec.md`, `src/worker/git-worktree-manager.ts` | Snapshot identity, create/release ownership, cleanup evidence |
| Change control-plane schema | `docs/control-plane-schema.md`, `control-plane/bootstrap.config.json` | Bootstrap tests, migration behavior, schema doc sync |

## Verification

Run the standard local gate before publishing changes:

```sh
pnpm run typecheck
pnpm run lint:ci
pnpm run test:cov
pnpm run verify
```

Use `pnpm run test:e2e` only when the change touches real host lifecycle, DBOS/Revisium behavior, MCP, GraphQL
subscriptions, runners, or recovery. It starts isolated local services and can require an unsandboxed terminal.
