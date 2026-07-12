# Specs

Specs are durable contracts for implemented or approved product surfaces. They hold exact types, schemas,
API behavior, state-machine grammar, validation rules, examples, and changelog notes.

Draft specs may live here when they are tied to a draft ADR or active design decision. They must be marked
`Status: Draft` and must clearly separate current shipped behavior from target migration.

Work orders, slices, task lists, and delivery sequencing do not live here. Track those in GitHub Issues or Revo
dogfooding runs. Obsolete plans are recovered from git history when needed; this repository does not keep a docs
archive of superseded plans.

## Current specs

| Spec | Contract |
| --- | --- |
| [graphql-admin-api-v1.spec.md](./graphql-admin-api-v1.spec.md) | Local GraphQL admin API: transport rules, graph-shaped contract, compatibility, and verification |
| [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md) | Data-driven pipeline template grammar, reducer contract, validation, versioning, and diff classification |
| [execution-plan-v1.spec.md](./execution-plan-v1.spec.md) | Draft immutable, fully resolved route/run input with playbook, graph, binding, policy, repository, resource, schema, budget, and secret-reference pins |
| [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md) | Step output production/consumption, prompt hydration, runtime output storage, and validation |
| [human-gates-v1.spec.md](./human-gates-v1.spec.md) | Inbox-backed human gates, gate resolution, question gates, watch tools, and PR review-feedback gates |
| [script-runtime-v1.spec.md](./script-runtime-v1.spec.md) | Draft versioned script/effect definitions, capability-scoped invocation, typed results/errors, idempotency, redaction, and bounded operation splits |
| [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md) | Draft repository snapshots, workspace plans, resource identity/lifecycle, filesystem capabilities, dirty-state handling, and artifact-store boundaries |
| [default-playbook-policy.spec.md](./default-playbook-policy.spec.md) | Bundled `feature-development` policy rules, static verifier scope, and merge-gate recheck behavior |
| [pipeline-test-coverage-v1.spec.md](./pipeline-test-coverage-v1.spec.md) | Pipeline test-layer ownership, DSL coverage matrix policy, profile coverage, and hard-skip rules |
| [test-architecture-v1.spec.md](./test-architecture-v1.spec.md) | Accepted target test-layer/context boundaries, runtime-evidence requirements, matrix ownership, migration, and CI constraints |
| [runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md) | Runner manifest field schema, ProtocolDriver/StdoutParser/PermissionStyle code contracts, route-time capability snapshot, and replay determinism |
| [runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md) | Canonical result envelope, structured-output tiers, `submit_result` tool-call mechanism, tier degradation, and the verdict-presence validate seam |
| [runner-capabilities-v1.spec.md](./runner-capabilities-v1.spec.md) | Runner capability vocabulary replacing the hardcoded branch functions, with one-to-one replacement mapping and worked `capabilities` examples |
| [acp-runner-session-v1.spec.md](./acp-runner-session-v1.spec.md) | Draft ACP attempt, invocation, process-group, session, prompt, replay, and cleanup contract |
| [run-profiles-v1.spec.md](./run-profiles-v1.spec.md) | Draft public run-profile contract for provider-neutral `feature-development`, profile-driven topology/bindings, MCP ergonomics, and replay pins |
| [playbook-storage-v1.spec.md](./playbook-storage-v1.spec.md) | Versioned playbook snapshot storage, document/entity projections, relation records, and route-time pins |
| [revo-playbook-materialization-v1.spec.md](./revo-playbook-materialization-v1.spec.md) | `.revo/playbook` worktree bundle layout, manifest validation, per-step selected references, and worker prompt discovery |
| [storage-database-layout-v1.spec.md](./storage-database-layout-v1.spec.md) | Draft storage v2 topology, database ownership, bootstrap order, and migration planes |
| [revo-prisma-engine-schema-v1.spec.md](./revo-prisma-engine-schema-v1.spec.md) | Draft Revo product DB schema ownership and embedded engine table compatibility |
| [revo-project-knowledge-migrations-v1.spec.md](./revo-project-knowledge-migrations-v1.spec.md) | Draft Revo project ADR/KB table initialization and engine migration contract |

## Current-state snapshots

| Snapshot | Ownership |
| --- | --- |
| [test-coverage-matrix-v1.json](./test-coverage-matrix-v1.json) | Documentation-owned Stage 2 working-tree snapshot and Stage 1 performance baseline; not the executable registry |

## Authoring rules

- Keep ADRs short. Put exact contracts here.
- Separate compatibility policy from the target public contract.
- Cite authoritative source files for implemented behavior.
- Include validation and compatibility rules, not just happy-path examples.
- Add a changelog entry when the contract changes.
