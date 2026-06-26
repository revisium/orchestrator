# agent-orchestrator

Local orchestrator for software-development tasks driven by short-lived AI agents. The runtime is a NestJS host
that uses DBOS for durable progress and Revisium for meaning: playbooks, roles, pipeline definitions, inbox rows,
events, costs, and projections.

The current product shape is daemon-first:

- `revo start` starts the Revisium standalone daemon plus the Revo host daemon.
- Agents use the local MCP server (`revo mcp`) for runs, gates, repository diagnostics, method discovery, and PR
  readiness.
- UI/scripts use the local GraphQL endpoint served by the daemon.
- The CLI is primarily lifecycle and diagnostics: `start`, `stop`, `status`, `restart`, `doctor`, and `logs`.

## Start here

- Repo context for agents: [AGENTS.md](./AGENTS.md)
- Docs index: [docs/README.md](./docs/README.md)
- Architecture: [docs/architecture-overview.md](./docs/architecture-overview.md)
- Specs: [docs/specs/](./docs/specs/)

## Local development

Use a named profile when running a source checkout next to an installed package. The `dev` profile has its own
ports, data directory, and DBOS database.

```sh
pnpm install
pnpm run revo -- start --profile dev
pnpm run revo -- status --profile dev
pnpm run revo -- doctor --profile dev
pnpm run revo -- logs --profile dev
pnpm run revo -- restart --profile dev
pnpm run revo -- stop --profile dev
```

| Knob | `default` | `dev` |
| --- | --- | --- |
| data dir | `~/.revisium-orchestrator` | `~/.revisium-orchestrator-dev` |
| standalone HTTP / Postgres | `19222` / `15440` | `19622` / `15840` |
| Revo GraphQL | `19223` | `19623` |
| DBOS database | `dbos` | `dbos_dev` |

Explicit environment variables override the profile: `REVO_DATA_DIR`, `REVO_PORT`, `REVO_PG_PORT`,
`REVO_GRAPHQL_PORT`, and `REVO_DBOS_DB`.

## MCP

`revo mcp` is a thin stdio bridge to the daemon. If the daemon is not running, the bridge starts it on first use.
The MCP process inherits `REVO_PROFILE` and related environment variables from its parent.

Global install:

```sh
claude mcp add revo -- revo mcp
codex mcp add revo -- revo mcp
```

Dev checkout:

```sh
claude mcp add revo-dev -- pnpm --dir "$PWD" run revo -- mcp
codex mcp add revo-dev -- pnpm --dir /abs/path/to/agent-orchestrator run revo -- mcp
```

After connecting, call `get_status` or `list_pipelines` from the MCP client to verify the bridge.

## GraphQL

The daemon serves GraphQL at:

```text
http://127.0.0.1:$REVO_GRAPHQL_PORT/graphql
```

Current SDL and migration rules are documented in
[docs/specs/graphql-admin-api-v1.spec.md](./docs/specs/graphql-admin-api-v1.spec.md). The committed SDL is
`src/api/graphql-api/schema.graphql`.

## Verification

```sh
pnpm run typecheck
pnpm run lint:ci
pnpm run test:cov
pnpm run verify
```

Smoke scripts that start local servers may require an unsandboxed terminal and isolated non-default ports.

## Upgrade ritual

```sh
npm i -g @revisium/orchestrator@<version>
revo restart
```

Then reconnect the MCP client so it refreshes its cached tool list.

## License

See [LICENSE](./LICENSE).
