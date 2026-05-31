# Getting started

> **Status: verified.** Commands were checked against the Plan 0001 `revo` CLI.
> **Depends on:** [plans/0001-revisium-daemon-and-bootstrap.md](./plans/0001-revisium-daemon-and-bootstrap.md)
> (the CLI) · `revisium.config.json` (ports, org/project/branch).
> **Realized by:** Plan 0001.

Run a local standalone Revisium as the orchestrator's control plane, then bootstrap its schema.

## Prerequisites

- **Node.js `>=24.11.1 <25`** (standalone's engine pin). Check: `node --version`.
- `npm install` in `agent-orchestrator/` (installs the standalone runtime + native deps).

## Start / stop the local Revisium daemon

```bash
npm run build
./bin/revo.js revisium start    # first run ~60–120s (downloads embedded PostgreSQL); later ~8s
./bin/revo.js revisium status   # running on http://localhost:<resolvedPort> — health OK
./bin/revo.js revisium logs -n 50
./bin/revo.js revisium stop     # graceful (PostgreSQL checkpoints cleanly)
```

**Ports:** preferred HTTP `19222` / pg `15440`. If busy, the CLI scans upward and `start` prints the **resolved**
port; it is also persisted in `runtime.json`. Never hardcode a port — read it from there. On the resolved port:

- Admin UI — `http://localhost:<port>/`
- REST + Swagger — `http://localhost:<port>/api`
- GraphQL — `http://localhost:<port>/graphql`
- MCP — `http://localhost:<port>/mcp`

(Port `9222` is deliberately avoided — reserved for a manually-run standalone, and it is Chrome's
remote-debugging port.)

## Bootstrap the control plane

```bash
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit   # creates the 10 control-plane tables and commits once
```

This commits the **schema** only (a structural, ADR-worthy change). Runtime rows are written to draft later and
never committed — see [control-plane-schema.md](./control-plane-schema.md).

Verify the generated REST endpoint:

```bash
curl http://localhost:<port>/endpoint/rest/admin/control-plane/master/draft/tables
curl http://localhost:<port>/endpoint/rest/admin/control-plane/master/draft/tables/steps
```

## Where data lives / reset

```text
~/.revisium-orchestrator/
├── pgdata/          # embedded PostgreSQL
├── jwt-secret       # generated internal JWT secret
├── uploads/         # local file uploads
├── runtime.json     # { httpPort, pgPort, pid, startedAt } — written by `start`
└── standalone.log   # daemon stdout/stderr
```

Reset everything: `./bin/revo.js revisium stop` then `rm -rf ~/.revisium-orchestrator`.

## Next

- The system in one page: [architecture-overview.md](./architecture-overview.md)
- The tables you just created: [control-plane-schema.md](./control-plane-schema.md)
