# GraphQL admin API v1 spec

- **Status:** Accepted target contract.
- **Contract owners:** `src/api/graphql-api/**`, `src/http/graphql-host.ts`, `src/features/**`.
- **Related ADRs:** [ADR-0003](../adr/0003-graphql-graph-shape.md).

## Scope

The GraphQL admin API is a local NestJS/Yoga front door for UI and scripts. It delegates to feature API services
over the same product logic as MCP. Resolvers and feature services must not read Revisium or DBOS internal tables
directly.

This spec defines the public GraphQL contract for the admin API. It does not define the MCP protocol. MCP tools
mirror many product verbs, but their wire contract lives in `src/mcp/mcp-tools.ts`.

## Transport

- Endpoint: `http://127.0.0.1:<REVO_GRAPHQL_PORT>/graphql`.
- Path: `/graphql`.
- Host bind: v1 permits loopback only; exposing the endpoint outside loopback requires an auth/principal seam at
  the `GraphqlApiModule` or Yoga context/plugin boundary before relaxing the bind rule.
- Port: `REVO_GRAPHQL_PORT`, otherwise the default resolved by `resolveDefaultGraphqlPort()`.
- WebSocket subscriptions are enabled by the host GraphQL WebSocket bridge.
- GraphQL operation metrics are recorded at the Yoga plugin boundary.
- Product validation and domain conflicts must be returned as stable GraphQL errors with `extensions.code`.

## Shape Principles

- Query roots are nouns with ids, list roots, or unscoped operations.
- Anything that requires a `runId` is a field on `Run`.
- A run screen uses one `run(id)` selection for workflow, events, inbox, attempts, agent observability, cost,
  usage, and progress.
- Domain types use clean names such as `Run`, `InboxItem`, and `WorkflowNode`.
- Use Relay-style connections for pageable collections.
- Use typed objects where the structure is known and backed by product data.
- Keep `JSON` only for truly open or product-defined payloads.
- Use enums for closed sets only. Open vocabularies such as `RunEvent.type` stay strings.

## Query Roots

```graphql
type Query {
  status: SystemStatus!
  doctor: DoctorResult!
  project: Project!

  runs(first: Int, after: String, status: RunStatus, priority: RunPriority): RunConnection!
  run(id: ID!): Run!

  inbox(first: Int, after: String, status: InboxItemStatus, kind: InboxItemKind): InboxConnection!
  inboxItem(id: ID!): InboxItem!

  playbooks(first: Int, after: String): PlaybookConnection!
  roles(first: Int, after: String): RoleConnection!
  role(id: ID!): Role!
  pipelines(first: Int, after: String): PipelineConnection!
  pipeline(id: ID!): Pipeline!

  validateRepository(repo: String!): RepositoryValidation!
  repositoryContext(repo: String!): RepositoryContext!
  simulateRoute(input: SimulateRouteInput!): RouteSimulation!
  prReadiness(input: PrReadinessInput!): PrReadiness!
  prFeedback(input: PrFeedbackInput!): PrFeedback!
}
```

The public query root must not expose run-scoped facet operations. These legacy root names are reserved for
removal or rejection in the public contract: `runWorkflow`, `runDigest`, `runProgress`, `runEvents`,
`runAttempts`, `runAgentActivity`, `runAgentAttempts`, `runAgentLog`, `pendingDecisions`, and `gateRisk`.

## Run Graph

`Run` is the canonical root for run-scoped state.

```graphql
type Run {
  id: ID!
  status: RunStatus!
  priority: RunPriority!
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  title: String
  goal: String
  issueRef: IssueRefModel

  progress: RunProgress!
  progressSummary: ProgressSummary!
  workflow: RunWorkflow!
  events(first: Int, after: String, type: String): RunEventConnection!
  activity(first: Int, after: String): RunActivityConnection!
  inbox(first: Int, after: String, status: InboxItemStatus, kind: InboxItemKind): InboxConnection!
  pendingInboxCount: Int!
  attempts(first: Int, after: String): RunAttemptConnection!
  cost(first: Int, after: String): RunCostConnection!
  usage: Usage!
  agent: RunAgent!
}
```

`RunProgress` contains scalar UI status and execution position. `ProgressSummary` contains node counts used by
lists and headers.

```graphql
type RunProgress {
  status: RunStatus!
  executionPosition: ExecutionPosition
  activeNodeIds: [ID!]!
}

type ProgressSummary {
  done: Int!
  total: Int!
}
```

`RunWorkflow` describes the graph structure and node states selected by the run.

```graphql
type RunWorkflow {
  playbookId: ID!
  pipelineId: ID!
  nodes: [WorkflowNode!]!
  edges: [WorkflowEdge!]!
}

type WorkflowNode {
  id: ID!
  kind: WorkflowNodeKind!
  title: String!
  status: WorkflowNodeStatus!
}

type WorkflowEdge {
  from: ID!
  to: ID!
}
```

`RunAgent` groups live agent observability. Live process attempts and persisted run attempts are separate
contract shapes because they have different lifecycles and sources.

```graphql
type RunAgent {
  activity(first: Int, after: String): AgentActivityConnection!
  attempts(first: Int, after: String): AgentAttemptConnection!
  log(first: Int, after: String): AgentLogConnection!
  output(first: Int, after: String): AgentOutputConnection!
}
```

## Source Of Truth

- Money is recorded through `Run.cost`; `Usage` is derived from the cost ledger.
- Inbox and gate state are read from `Run.inbox`, `Run.pendingInboxCount`, and inbox row `status`.
- Persisted accounting belongs to `RunAttempt`.
- Live process state belongs to `RunAgent`.
- `RunEvent` is the immutable event log. `RunActivity` is a derived human-readable feed.
- Overlapping aggregate projections are not part of the public run contract when equivalent graph fields exist.

## Mutations

```graphql
type Mutation {
  createRun(input: CreateRunInput!): CreateRunResult!
  startRun(id: ID!): Run!
  cancelRun(id: ID!, reason: String): Run!
  installPlaybook(input: InstallPlaybookInput!): InstallPlaybookResult!

  resolveInboxItem(input: ResolveInboxItemInput!): InboxResolution!
  approveGate(input: GateDecisionInput!): InboxResolution!
  rejectGate(input: GateDecisionInput!): InboxResolution!
  answerQuestion(input: AnswerQuestionInput!): InboxResolution!
}
```

`startRun` and `cancelRun` are idempotent lifecycle mutations. Starting an already-running run returns the run.
Canceling a terminal run returns the run. Continuation after a human gate or question is driven by inbox
resolution; the public contract does not define a separate resume mutation.

Mutation resolvers must enforce the auth/principal seam before the API can bind outside loopback.

`CreateRunInput` accepts optional `issueRef: IssueRefInput` traceability metadata with shape
`{ repo: String!, number: positive Int!, url: String! }`. The canonical value is stored in public run params as
`params.issueRef`; if `CreateRunInput.issueRef` and `CreateRunInput.params.issueRef` are both present and differ,
the mutation rejects the input deterministically. `Run.issueRef`, run digest/read projections, and PR readiness
results project only this structured `IssueRefModel` metadata, not arbitrary run params.

`PrReadinessInput` also accepts optional `issueRef` with the same shape. For issue-bound runs, readiness reports a
human-decision item when branch/title linkage is missing; the link policy is reference-only and must not emit
closing keywords such as `Closes`, `Fixes`, or `Resolves`. Issue closure remains a manual/out-of-band action; this
API must not call issue-close endpoints. Issue-bound PR titles and commits may include a non-closing `#<number>`
same-repo reference or `owner/repo#<number>` cross-repo reference, and PR bodies may remain empty for compatibility
with the existing publication flow.

## Subscriptions

State changes push a thin token:

```graphql
type Subscription {
  runChanged(runId: ID!): RunChange!
  runEventAppended(runId: ID!): RunEvent!
  runCostAppended(runId: ID!): RunCost!
  runAgentOutputAppended(runId: ID!): AgentOutput!
  inboxItemAdded(runId: ID): InboxItem!
  inboxItemResolved(runId: ID): InboxItem!
}

type RunChange {
  runId: ID!
  changedAt: DateTime!
  kind: RunChangeKind!
}
```

Append streams push appended items. State changes push `RunChange`, and clients refetch the selected `run(id)`
fields they already render.

## Naming And Typing

Closed sets are enums:

```graphql
enum RunStatus {
  QUEUED
  RUNNING
  BLOCKED
  SUCCEEDED
  FAILED
  CANCELED
}

enum RunPriority {
  LOW
  NORMAL
  HIGH
}

enum InboxItemKind {
  APPROVAL
  QUESTION
  REVIEW_FEEDBACK
}

enum InboxItemStatus {
  PENDING
  RESOLVED
  REJECTED
  CANCELED
}

enum WorkflowNodeKind {
  AGENT
  HUMAN_GATE
  SCRIPT
}

enum RunChangeKind {
  STATUS
  PROGRESS
  WORKFLOW
  AGENT
}
```

`RunEvent.type` remains `String!` because event types are playbook-extensible. A GraphQL enum must not reject
unknown event types.

Status normalization happens at the API boundary. Internal workflow or storage vocabulary must not leak if the
public enum has a more precise UI-facing value.

## Compatibility And Removal Policy

Compatibility phases may keep deprecated aliases while consumers move to the graph-shaped selection, but the
target public contract is the graph above. Deprecated aliases must point at the same source-of-truth paths as the
graph fields and must not introduce second read windows for money, inbox, progress, or activity.

Removal order:

- add graph-shaped fields and lifecycle operations;
- add `RunChange` and append-item streams;
- port consumers to `run(id)` selections and typed results;
- remove run-scoped legacy roots, overlapping aggregate projections, and JSON twins;
- remove generated `*Model` names from the public SDL in favor of explicit domain names.

## Performance

This contract states graph shape, ownership, and source-of-truth rules. It does not guarantee N+1 elimination or
particular batching mechanics. Implementations should bound list fan-out and add batching in feature services
where needed.

## Validation

- GraphQL schema drift tests guard intentional contract changes.
- Host e2e coverage must include one read path, one sanctioned write, and one `graphql-ws` subscription triggered
  by that write.
- CLI, MCP, DBOS, and GraphQL tests must prove resolvers delegate to product feature services instead of forking
  product logic.
- Contract tests must cover `Run.usage` deriving from `Run.cost`, inbox/gate status deriving from inbox row
  status, lifecycle mutation idempotency, and stable `extensions.code` errors.

## Changelog

- 2026-06-27: Added issueRef create-run, Run projection, and PR readiness linkage contract.
- 2026-06-26: Erratum: explicitly added `runAttempts` to the legacy run-scoped root reserved/removal list,
  backfilling a previous omission without changing the accepted graph-shaped target contract.
- 2026-06-26: Reframed the spec as the accepted graph-shaped target contract.
