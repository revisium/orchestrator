# agent-orchestrator

Local orchestrator for software-development tasks driven by short-lived AI agents (architect → developer →
reviewer → integrator), hosted in **NestJS**. **DBOS** owns durable progress — execution is crash-safe and resumes
from the first unfinished step — while **Revisium** owns meaning: roles, policy, inbox, events. Workflow-as-data is
a post-MVP goal; see [`docs/architecture-overview.md`](./docs/architecture-overview.md).

> 🚧 **Early alpha.** The end-to-end MVP works — create a run → plan gate → implement → review → PR → merge
> gate — see [`docs/roadmap.md`](./docs/roadmap.md).

## Start here

- Repo context for agents: [`AGENTS.md`](./AGENTS.md)
- Vision: [`docs/vision.md`](./docs/vision.md)
- Architecture & invariants: [`docs/architecture-overview.md`](./docs/architecture-overview.md)
- Docs index & roadmap: [`docs/README.md`](./docs/README.md) · [`docs/roadmap.md`](./docs/roadmap.md)

## Local Development

`revo` is one daemonized product. **`revo start`** brings up the whole stack — the standalone
Revisium daemon plus the Revo host daemon that owns DBOS and serves the GraphQL + MCP front doors —
and bootstraps the control-plane so it is ready to use. The CLI is lifecycle-only
(`start` / `stop` / `status` / `restart` / `doctor` / `logs`); orchestration (runs, inbox, …) is
reached over **MCP** (agents) or **GraphQL** (UI/scripts), both served by the daemon.

Run a source checkout alongside an installed package without collisions via a named **profile**
(`--profile dev`, or `REVO_PROFILE=dev`): the `dev` profile shifts the whole port band off the
`default` profile, so the two never share a port, data dir, or `dbos` database.

```sh
pnpm install
pnpm run revo -- start --profile dev    # standalone + host daemon, bootstrapped & ready
pnpm run revo -- status --profile dev   # stack health summary
pnpm run revo -- doctor --profile dev   # diagnose process / port / profile issues
pnpm run revo -- logs --profile dev     # tail host + standalone logs; add -f to follow
pnpm run revo -- restart --profile dev  # stop, then start
pnpm run revo -- stop --profile dev
```

| Knob | `default` (installed package) | `dev` (source checkout) |
| --- | --- | --- |
| data dir | `~/.revisium-orchestrator` | `~/.revisium-orchestrator-dev` |
| standalone HTTP / Postgres | `19222` / `15440` | `19622` / `15840` |
| Revo GraphQL | `19223` | `19623` |
| DBOS database | `dbos` | `dbos_dev` |

Any single knob can be overridden explicitly — `REVO_DATA_DIR` / `REVO_PORT` / `REVO_PG_PORT` /
`REVO_GRAPHQL_PORT` / `REVO_DBOS_DB` — and an explicit env var always wins over the profile band.

Connect an agent over MCP (a thin stdio bridge that forwards to the running daemon):

```sh
claude mcp add revo -- pnpm --dir "$PWD" run revo -- mcp
```

Run the local verification gates:

```sh
pnpm run typecheck
pnpm run lint:ci
pnpm run test:cov
pnpm run verify
```

The smoke scripts are guarded: they require a non-default `REVO_DATA_DIR`,
`REVO_PORT`, `REVO_PG_PORT`, and `REVO_DBOS_DB`; GraphQL smoke paths also require
`REVO_GRAPHQL_PORT`.

```sh
pnpm run smoke:control-plane
pnpm run smoke:create-run
pnpm run smoke:inspect-run
```

### Live Run Observability Smoke

This smoke runs a real agent. It can call provider CLIs and incur cost. Use it
only when that is intentional.

```sh
export REVO_SMOKE_REPO=/path/to/local/sandbox-repo
pnpm run revo -- start --profile dev   # standalone + host daemon (serves GraphQL + MCP), ready
```

Drive and observe a run through the daemon's front doors — there are no `run`/`serve` CLI commands.
From an agent, use the MCP tools (`create_run`, `start_run`, then `get_agent_activity` /
`get_agent_log`). From a UI or script, use the GraphQL front door the daemon already serves at
`http://127.0.0.1:$REVO_GRAPHQL_PORT/graphql` — create a run:

```graphql
mutation Create($data: CreateRunInput!) {
  createRun(data: $data) {
    runId
  }
}
```

Then observe it over the same endpoint:

```graphql
query Activity($runId: ID!) {
  runAgentActivity(runId: $runId) {
    runId
    aggregateStatus
    latestOutputAt
    attempts {
      attemptId
      runner
      status
      stdoutBytes
      stderrBytes
      artifactRef
    }
  }
}

query Log($data: GetAgentLogInput!) {
  runAgentLog(data: $data) {
    runId
    attemptId
    stream
    offsetBytes
    nextOffsetBytes
    totalBytes
    truncated
    content
  }
}
```

For MCP, configure the MCP client to launch this checkout's local binary with the
same environment. The MCP tools do not accept per-call profile arguments; the
profile comes from the process environment.

```json
{
  "mcpServers": {
    "revo-dev": {
      "command": "/path/to/agent-orchestrator/bin/revo.js",
      "args": ["mcp"],
      "env": {
        "REVO_DATA_DIR": "/path/to/.revisium-orchestrator-dev",
        "REVO_PORT": "19622",
        "REVO_PG_PORT": "15840",
        "REVO_GRAPHQL_PORT": "19623",
        "REVO_DBOS_DB": "dbos_dev"
      }
    }
  }
}
```

Useful MCP observability tools for the same run:

- `get_agent_activity`
- `get_agent_attempts`
- `get_agent_log`
- `read_agent_output_events`
- `tail_agent_log`

If running from a sandboxed automation environment, local server checks may fail
with `listen EPERM` or a misleading `No free port found from <port>`. Re-run the
daemon, GraphQL, and MCP smoke commands from a normal terminal or an approved
unsandboxed execution context.

## License

See [LICENSE](./LICENSE).
