# GraphQL API

The GraphQL front door is a local-only NestJS/Yoga transport over the same `TaskControlPlaneApiService` used by
CLI and MCP. It does not own product logic and must not read Revisium or DBOS tables directly.

## Binding and auth

GraphQL v1 is intentionally bound to `127.0.0.1` only. `REVO_GRAPHQL_HOST` may only resolve to that loopback host;
other bind addresses fail during option resolution before the HTTP server starts.

There is no authz layer in v1 because the host is local-only. If this endpoint is ever exposed beyond loopback, add
the auth guard at the GraphQL module boundary (`GraphqlApiModule` / Yoga context or plugin setup) before relaxing the
bind invariant. Do not add per-resolver auth checks as the first step; the transport boundary should establish the
principal once and keep resolvers as thin delegators.

## Observability

`createGraphqlMetricsPlugin` records in-process operation count, duration, and error counters by GraphQL operation
type/name. It is intentionally an infrastructure hook, not a domain dependency. A future metrics exporter should read
the collector snapshot rather than changing resolvers or CQRS handlers.

## Admin UI contract

The run detail screen should use `runWorkflow(id)` as its primary read model. It is an access-layer projection over
existing sealed verbs: run metadata, route/template data, `runProgress`, `runEvents`, pending inbox decisions, and
`getRunLog`. Resolvers and CQRS handlers still delegate through `TaskControlPlaneApiService`; they do not read DBOS or
Revisium tables directly.

`runWorkflow(id)` is the stable UI shape for the pipeline graph:

- `run` gives the display run row. GraphQL normalizes the blocked runtime row (`paused`) to `blocked` for UI status.
- `pipeline` gives the selected playbook/pipeline, active node ids, route gates, and cursor status.
- `nodes` and `edges` describe the graph from the data-driven pipeline template.
- `gates` and `pendingInbox` describe human approval/question state.
- `attempts`, `usage`, and `activity` provide provenance, spend, and timeline summaries.

Use `runAttempts(data)` when the UI needs the provenance table independently of the graph. This is not legacy
`steps` modeling: attempts are exposed only through the sealed `getRunLog` verb, matching MCP's `get_run_log`.

Use `runWorkflowUpdated(data)` for the run-detail live feed. The low-level subscriptions remain available for clients
that want to manage their own cache (`runUpdated`, `runProgressUpdated`, `runEventAppended`, `runCostRecorded`,
`inboxItemAdded`, `inboxItemResolved`).

PR readiness now has typed GraphQL variants for UI codegen: `prReadinessTyped(data)` and `prFeedbackTyped(data)`.
The older `prReadiness(data): JSON` and `prFeedback(data): JSON` remain as compatibility/debug pass-throughs.

## Verification contract

Keep `src/api/graphql-api/schema.graphql` committed and covered by the schema drift test. Real-host e2e must cover:

- a read path;
- one sanctioned write;
- one `graphql-ws` subscription triggered by the write.

The existing CLI/MCP/DBOS e2e suite remains the regression guard that the GraphQL front door did not fork or replace
the shared control-plane verbs.
