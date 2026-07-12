# ADR-0010 - Run resources and workspace planning

- **Status:** Draft
- **Decision date:** 2026-07-11
- **Specs:** [Execution plan v1](../specs/execution-plan-v1.spec.md),
  [resources, workspaces, and effects v1](../specs/resources-workspaces-effects-v1.spec.md)
- **Refines:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md),
  [ADR-0006](./0006-run-profiles-and-provider-neutral-pipelines.md),
  [ADR-0008](./0008-revo-projects-and-versioned-knowledge.md)
- **Relates-to:** [ADR-0004](./0004-runner-execution-contract.md),
  [script runtime v1](../specs/script-runtime-v1.spec.md),
  [run dataflow v1](../specs/run-dataflow-v1.spec.md)

## Context

Revo's graph is data-driven, but run preparation is not. The shipped path requires a repository, infers live-worktree
need from concrete runner and script ids, derives a branch during worktree creation, expands GitHub identities across a
hardcoded node list, and represents worktree cleanup as a graph node. Recovery can therefore depend on mutable host
configuration and product-specific adapter branches that are not visible in the pipeline contract.

Repository-free work also lacks a safe workspace contract. Falling back to the host process directory would expose
unrelated files and make execution depend on launch location.

## Decision

Pipelines declare portable, named resources and workspace intent. Effect nodes declare required access and captures
against those names. Before DBOS enqueue, Revo resolves the selected playbook, profile, runners, repository inputs,
credential aliases, workspace providers, deterministic branch policy, and script definitions into one immutable
`ExecutionPlan`.

`RouteDecision` remains the owner of selection provenance. It is nested once inside `ExecutionPlan`; runner, profile,
materialized-template, and playbook pins remain owned by that component and are not copied into parallel plan fields.
The target run row stores `executionPlan` and `executionPlanHash` instead of treating a standalone route decision as the
complete execution input.

The plan is self-contained with respect to mutable data and policy: execution and recovery do not re-read repository
rows, profiles, playbook HEAD, launch bindings, or registries to reconstruct decisions. Trusted executable code remains
a host build concern and must match the identities pinned by the plan.

Every run receives an isolated workspace plan:

- a repository-free pipeline receives a newly created scratch directory;
- a mutable Git repository resource receives a resolved Git worktree plan, including pinned base revision and branch;
- read-only repository access uses the explicitly resolved provider plan and never an implicit host checkout;
- preparation and release are resource lifecycle, outside graph topology, and run on the lifecycle paths defined by the
  spec.

Pipeline resource declarations stay portable. Provider-specific facts such as Git remote identity, commit ids, and
branches appear only in resolved resource/workspace plans and typed artifacts. Absolute workspace paths are host-owned
allocation facts keyed by the pinned `workspaceId`; they are neither plan meaning nor public API data. V1 deliberately
supports Git and GitHub operations directly; it does not introduce a provider-neutral `delivery/*` facade.

Node requirements express desired access and capture. Runner manifests express runner ability. Generic execution must
not infer workspace behavior from runner, script, or node ids. In particular, the target removes runner-driven
`needsLivePreflight`, `producesWorktreeChanges`, and `performsMerge` policy; resource validation and node declarations
own those decisions.

Credentials are pinned aliases and resolver provenance only. Tokens and sessions remain host-local and never enter
playbook meaning, route decisions, execution plans, outputs, or events.

### Target module map

The implementation converges on the following ownership map. These paths identify the single public owner for each
contract; private helpers and colocated tests may be added, but a second resource parser, execution-plan compiler,
workspace lifecycle, or production adapter is forbidden.

```text
prisma/
  schema.prisma                              # RevoRepository, plan/hash, WorkspaceAllocation
  migrations/                               # additive staging, then the atomic V2 cutover
src/
  run-resources/
    types.ts                                 # portable declarations and launch bindings
    parse-run-resource-input.ts              # closed V1 resource-input validation
    revo-repository.store.ts                 # mutable configuration lookup for future runs
    canonical-json.ts                        # sole canonicalize@3.0.0 wrapper
  execution-plan/
    types.ts                                 # ExecutionPlanV1 and resolved plan types
    diagnostics.ts                           # closed compilation diagnostics
    compiler.ts                              # sole execution-plan compiler
    hash-execution-plan.ts                   # SHA-256 over bytes returned by canonical-json.ts
    execution-plan.store.ts                  # atomic plan/hash persistence
    prepare-for-enqueue.ts                   # compile, validate, persist, then enqueue fence
  workspaces/
    types.ts                                 # lifecycle state and private lease contracts
    workspace-allocation.store.ts            # durable allocation and fencing owner
    workspace-lifecycle.service.ts            # prepare/release/recover orchestration
    workspace-events.ts                      # closed redacted lifecycle events
    scratch-workspace.provider.ts            # repository-free isolated allocation
    git-command.ts                           # bounded argv-only Git adapter
    git-repository-cache.ts                  # Revo-owned exact-ref cache
    git-worktree-workspace.provider.ts       # pinned worktree prepare/inspect/release
  run/
    create-run.ts                            # target public input; invokes the sole compiler
  task-control-plane/
    task-control-plane-api.service.ts        # create/start/resume target integration
  pipeline/
    pipeline.service.ts                      # existing DBOS enqueue and dependency-wiring point
    data-driven-task.workflow.ts             # existing host of the sole plan-backed adapter
  pipeline-core/
    duration.ts                              # closed durable-wait duration parser
  system-scripts/                            # neighboring boundary; detailed layout owned by ADR-0011
```

Generated Prisma files under `src/__generated__/`, existing module wiring, API adapters, policy/verifier files, catalog
data, private helpers, and colocated tests follow their existing repository owners and are omitted from the tree. The
`run`, `task-control-plane`, and `pipeline` entries are existing integration points, not parallel domain owners.
`data-driven-task.workflow.ts` hosts the sole plan-backed adapter composition but does not own resource parsing, plan
compilation, workspace lifecycle, or script execution. D01-D12 build and prove the target modules without activating a
second production path; D13 rewires those integration points atomically and deletes the replaced owners. The complete
operation-folder layout beneath `src/system-scripts/` remains normative only in ADR-0011 and its specification.

## Alternatives

- **Keep repository/worktree behavior in the adapter.** Rejected because the graph and replay pin would remain
  incomplete and arbitrary ids would continue to carry hidden semantics.
- **Model worktree preparation and release as scripts.** Rejected because graph routing can bypass lifecycle cleanup,
  and ordinary script retry semantics do not own resource allocation.
- **Use the host checkout or cwd for repository-free work.** Rejected because it is neither isolated nor deterministic.
- **Add compatibility aliases and dual execution paths.** Rejected. Alpha data and old run shapes are not migrated.
- **Create a provider-neutral delivery resource facade.** Rejected for V1. Git and GitHub are explicit product
  dependencies in this milestone.

## Consequences

- Run creation becomes a compile-and-validate boundary before enqueue.
- Repository-free runs become first-class.
- Branch identity, workspace allocation, access, captures, and credential aliases are inspectable before execution.
- Recovery reuses the exact plan and fails closed when its trusted executable dependencies are unavailable.
- Worktree release cannot be skipped by a graph edge.
- The bundled pipelines require one atomic policy cutover; old cleanup nodes, account expansion, and id-based adapter
  branches are deleted rather than retained as fallbacks.
- V1 launches zero or one named repository resource. Multiple workspace roots and cross-repository coordination require
  a later schema decision.

## Follow-ups

Reusable pipeline fragments and a public or untrusted plugin SDK are separate decisions. They are not deliverables of
this ADR.
