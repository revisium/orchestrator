# Getting started

This guide starts the local Revo stack and verifies both front doors: MCP for agents and GraphQL for UI/scripts.

## Prerequisites

- Node.js `>=24.11.1 <25`.
- `pnpm install` in this repo for source checkout development.
- `gh` auth and a clean target repo when the selected pipeline uses real GitHub/integrator behavior.

## Start the daemon

Use the `dev` profile for source checkout work so it does not collide with a globally installed Revo.

```sh
pnpm run revo -- start --profile dev
pnpm run revo -- status --profile dev
pnpm run revo -- doctor --profile dev
```

The `dev` profile uses:

- Revisium HTTP: `19622`
- embedded Postgres: `15840`
- GraphQL: `19623`
- DBOS database: `dbos_dev`
- data directory: `~/.revisium-orchestrator-dev`

## Connect MCP

Register the source checkout with an MCP-capable agent:

```sh
codex mcp add revo-dev -- pnpm --dir /abs/path/to/agent-orchestrator run revo -- mcp
```

For Claude Code:

```sh
claude mcp add revo-dev -- pnpm --dir "$PWD" run revo -- mcp
```

If using the dev profile, make sure the MCP client process inherits `REVO_PROFILE=dev` or the explicit port/data
environment variables.

Verify from the agent by calling:

- `get_status`
- `list_pipelines`
- `get_project`

Core MCP verbs include run creation/start/cancel, watch tools, inbox gate resolution, repository diagnostics,
playbook/role/pipeline discovery, and PR readiness.

## Use GraphQL

The dev profile endpoint is:

```text
http://127.0.0.1:19623/graphql
```

Create a run:

```graphql
mutation Create($data: CreateRunInput!) {
  createRun(data: $data) {
    runId
    status
    started
  }
}
```

Read the run workflow:

```graphql
query Workflow($id: ID!) {
  runWorkflow(id: $id) {
    run {
      id
      title
      status
    }
    pipeline {
      pipelineId
      status
      activeNodeIds
    }
    gates {
      nodeId
      status
      inboxId
    }
  }
}
```

Read agent activity:

```graphql
query Activity($runId: ID!) {
  runAgentActivity(runId: $runId) {
    runId
    aggregateStatus
    latestOutputAt
  }
}
```

The current SDL is documented in
[specs/graphql-admin-api-v1.spec.md](./specs/graphql-admin-api-v1.spec.md).

## Resolve gates

Use MCP for agent-driven work:

- `list_inbox`
- `approve_gate`
- `reject_gate`
- `answer_question`
- `wait_for_any_gate`
- `watch_runs`

Use GraphQL for UI/script flows:

- `inbox(data: ...)`
- `approveGate(data: ...)`
- `rejectGate(data: ...)`
- `answerQuestion(data: ...)`
- `resolveInboxItem(data: ...)`

Gate semantics are specified in [specs/human-gates-v1.spec.md](./specs/human-gates-v1.spec.md).

## Stop and inspect

```sh
pnpm run revo -- logs --profile dev
pnpm run revo -- stop --profile dev
```

Ctrl-C in an MCP or script client does not erase DBOS progress. Reconnect through MCP or GraphQL and reattach by
run id.
