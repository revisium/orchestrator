# GraphQL admin API v1 spec

- **Status:** Accepted for current v1 surface; graph-shape section is an approved migration target.
- **Source files:** `src/api/graphql-api/schema.graphql`, `src/api/graphql-api/graphql-api.module.ts`,
  `src/http/graphql-host.ts`, `src/api/graphql-api/**`, `src/features/**`.
- **Related ADRs:** [ADR-0003](../adr/0003-graphql-graph-shape.md).

## Scope

The GraphQL admin API is a local NestJS/Yoga front door for UI and scripts. It delegates to feature API services
over the same product logic as MCP. Resolvers and feature services must not read Revisium or DBOS internal tables
directly.

This spec does not define the MCP protocol. MCP tools mirror many product verbs, but their wire contract lives in
`src/mcp/mcp-tools.ts`.

## Transport

- Endpoint: `http://127.0.0.1:<REVO_GRAPHQL_PORT>/graphql`.
- Path: `/graphql`.
- Host bind: v1 only permits `127.0.0.1`; other `REVO_GRAPHQL_HOST` values fail before the server starts.
- Port: `REVO_GRAPHQL_PORT`, otherwise the default resolved by `resolveDefaultGraphqlPort()`.
- WebSocket subscriptions are enabled by `addWsServer(app)`.
- v1 has no auth layer because the endpoint is loopback-only. Exposing the endpoint outside loopback requires an
  auth/principal seam at `GraphqlApiModule` or Yoga context/plugin boundary before relaxing the bind rule.
- GraphQL operation metrics are recorded by `createGraphqlMetricsPlugin()`.

## Current v1 Surface

The committed SDL in `src/api/graphql-api/schema.graphql` is the source of truth. It is intentionally still mostly
flat/RPC-shaped.

Top-level query groups:

- System: `status`, `doctor`, `project`, `validateRepository`, `repositoryContext`.
- Runs: `runs`, `run`, `runEvents`, `runAttempts`, `runDigest`, `runProgress`, `runWorkflow`,
  `runAgentActivity`, `runAgentAttempts`, `runAgentLog`.
- Inbox: `inbox`, `inboxItem`, `pendingDecisions`, `gateRisk`.
- Method: `playbooks`, `roles`, `role`, `pipelines`, `pipeline`, `simulateRoute`.
- PR: `prReadiness`, `prReadinessTyped`, `prFeedback`, `prFeedbackTyped`.

Mutations:

- `createRun(data: CreateRunInput!): CreateRunResultModel!`
- `resolveInboxItem(data: ResolveInboxItemInput!): InboxResolutionModel!`
- `approveGate(data: GateDecisionInput!): InboxResolutionModel!`
- `rejectGate(data: GateDecisionInput!): InboxResolutionModel!`
- `answerQuestion(data: AnswerQuestionInput!): InboxResolutionModel!`

Subscriptions:

- `runUpdated`, `runProgressUpdated`, `runWorkflowUpdated`
- `runEventAppended`, `runCostRecorded`
- `runAgentActivityUpdated`, `runAgentOutputAppended`
- `inboxItemAdded`, `inboxItemResolved`

Current naming and typing:

- Code-first type names still use `*Model` suffixes, for example `RunModel`, `RunWorkflowModel`,
  `InboxItemModel`.
- Many statuses are `String!`, not enums.
- Several fields intentionally remain `JSON`, including `CreateRunResultModel.route`,
  `CreateRunResultModel.workflow`, `RunProgressModel.graphCursor`, `PipelineModel.executionPolicy`,
  `RoleModel.scopeRules`, and inbox/gate payload fields.
- `RunEventModel.type` is `String!` because event types are playbook-extensible.
- Connections are used for `runs`, `runEvents`, `runAttempts`, `inbox`, `roles`, `pipelines`, and `playbooks`.
  Some run facets are still bare lists.

## Current Run Detail Contract

`runWorkflow(id)` is the current primary UI projection for a run detail screen. It joins run metadata, pipeline
template structure, progress cursor, events, pending inbox items, attempts, usage, and activity through the sealed
feature service layer.

`RunWorkflowModel` contains:

- `run`: display run row.
- `pipeline`: selected playbook/pipeline, active node ids, route gates, and pipeline status.
- `nodes` and `edges`: graph materialized from the data-driven pipeline template.
- `gates` and `pendingInbox`: human approval/question state.
- `attempts`, `usage`, and `activity`: provenance, spend, and timeline summaries.
- `currentNodeIds`: active cursor nodes.

GraphQL normalizes the runtime `paused` row status to `blocked` for UI-facing run status.

## Validation

- `src/api/graphql-api/graphql-schema.test.ts` guards SDL drift.
- The committed `schema.graphql` must be regenerated intentionally when code-first types change.
- Real-host e2e coverage must include one read path, one sanctioned write, and one `graphql-ws` subscription
  triggered by that write.
- The CLI/MCP/DBOS e2e suite remains the guard that GraphQL did not fork product logic.

## Target Graph-Shape Migration

ADR-0003 approves a migration from the current flat surface to a graph-shaped contract. This is not current SDL
yet.

Principle: query roots are nouns with ids, list roots, and unscoped operations. Anything scoped by `runId` becomes
a field on `Run`, not a top-level query.

Target query roots:

```graphql
type Query {
  runs(...): RunConnection!
  inbox(...): InboxConnection!
  roles(...): RoleConnection!
  pipelines(...): PipelineConnection!
  playbooks(...): PlaybookConnection!
  run(id: ID!): Run!
  inboxItem(id: ID!): InboxItem!
  role(id: ID!): Role!
  pipeline(id: ID!): Pipeline!
  status: SystemStatus!
  doctor: DoctorResult!
  project: Project!
  validateRepository(repo: String!): RepositoryValidation!
  repositoryContext(repo: String!): RepositoryContext!
  simulateRoute(...): RouteSimulation!
  prReadiness(...): PrReadiness!
  prFeedback(...): PrFeedback!
}
```

Target `Run` owns run-scoped facets:

- `usage`, derived from cost ledger.
- `progress`, scalar status plus execution position.
- `progressSummary`, node-count summary.
- `workflow`, graph structure.
- `events`, `activity`, `inbox`, `attempts`, `cost`.
- `agent`, live observability subtree.
- `pendingInboxCount`.

Source-of-truth rules for the target:

- Money has one source: `Run.cost`; `Run.usage` is derived from it.
- Inbox has one source: `Run.inbox`, `Run.pendingInboxCount`, and gate status read through the same run-scoped
  inbox path.
- Drop overlapping aggregate projections such as `Run.digest` once equivalent real fields exist.
- `RunAttempt` is persisted accounting; `AgentAttempt` is live process state.
- `RunEvent` is raw immutable log; `RunActivity` is derived human-readable feed.

Target subscriptions:

- Append-log item streams push items: `runEventAppended`, `runCostAppended`, `runAgentOutputAppended`,
  `inboxItemAdded`, `inboxItemResolved`.
- State changes push a thin token: `runChanged(runId): RunChange!`, with kind values for status, progress,
  workflow, and agent.

Target mutations:

- Keep `createRun` and inbox resolution mutations.
- Add `startRun`, `cancelRun`, and `installPlaybook`.
- Do not add a separate `resumeRun`; continuation after a gate is automatic via inbox resolution. `startRun`
  is idempotent and can reattach a durable workflow.

Target naming and typing:

- Use explicit code-first names (`@ObjectType('Run')`) and migrate away from `*Model` SDL names in two phases:
  add/deprecate, then remove.
- Use enums for closed sets only (`RunStatus`, `RunPriority`, inbox status/kind, workflow node kind).
- Keep open vocabularies such as `RunEvent.type` as strings.
- Replace JSON fields with typed objects only when the structure is known and backed by source data.

Performance rule: this contract states graph shape and source ownership. It does not promise N+1 elimination.
Batching is a service-layer implementation concern.

## Changelog

- 2026-06-26: Initial spec extracted from current SDL/source and GraphQL graph-shape ADR inputs.
