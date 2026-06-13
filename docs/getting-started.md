# Getting started

Run a local Revisium daemon as the orchestrator's control plane, bootstrap its schema, and drive the
architect→developer→reviewer→integrator pipeline from a single command.

## Install

```bash
npm i -g @revisium/orchestrator@alpha   # global install from the alpha dist-tag
revo --version                          # prints 0.1.0-alpha.0 (from dist, not tsx)
```

> **Node 24.11.x required** — the `@revisium/standalone` daemon dependency declares
> `engines: ">=24.11.1 <25"`. `npm i` on an unsupported Node version prints a warning;
> the daemon will fail to start.

Installed users run `revo …` (global bin). In-repo development can use `./bin/revo.js …`
(runs the built `dist/`, so `pnpm run build` must be run first) or `pnpm run revo -- <args>`
(runs `tsx src/cli/index.ts` directly from source, no build step needed). Both invocation
styles are shown below.

## The model (two processes, one Postgres)

Two processes share one embedded Postgres server:

- **(a) Revisium standalone daemon** — owns the embedded Postgres; source of truth for *meaning*
  (roles, policy, inbox, events, cost rows). Runs as a background process managed by the `revo`
  CLI.
- **(b) NestJS host** — starts inside the CLI process when you run a host-requiring command (e.g.
  `run create --start`). It boots the **DBOS** engine, which connects to a separate `dbos` database
  on the same Postgres server and drives durable workflow execution.

One Postgres server, two databases: Revisium's own database + the `dbos` database the host creates
on first boot.

- **Revisium** holds *meaning* (versioned: roles/policy; draft: inbox/events).
- **DBOS** holds *progress* (which step ran, gate decisions, workflow state) — never in Revisium,
  never in files.

See [architecture-overview.md](./architecture-overview.md) and
[adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md).

## Prerequisites

- **Node.js 24.11.x** (`>=24.11.1 <25`) — check with `node --version`. This range is imposed by
  the `@revisium/standalone` daemon dependency; a wider range is not supported.
- For in-repo development: `pnpm install` in `agent-orchestrator/` and `pnpm run build`.
- `gh` auth + a clean target repo are needed only for the `--live` path (real Claude + real PR).
  The zero-cost stub path requires none of these.
- `bootstrap` fetches `npx -y revisium@2.5.0-alpha.6` on first run — network access is required
  for that one-time step; subsequent `revo` commands work offline.

## Step 1 — start the control plane

```bash
./bin/revo.js revisium start     # first run ~60–120s (downloads embedded PostgreSQL); later ~8s
./bin/revo.js revisium status    # running on http://localhost:<resolvedPort> — health OK
./bin/revo.js bootstrap --commit # creates the 12 control-plane tables, seeds fixed roles/profiles, and commits
```

**Ports:** preferred HTTP `19222` / pg `15440`. If busy, the CLI scans upward and `start` prints
the **resolved** port; it is also persisted in `runtime.json`. Never hardcode a port.

On first boot the host will also create the `dbos` database automatically (idempotent).

`bootstrap --commit` also seeds the fixed roles (`architect`, `developer`, `reviewer`, `integrator`)
and the three `model_profiles` (`deep`, `standard`, `cheap`). This is what lets the very first
`run create --start` resolve `loadRole` and run the pipeline without error.

To import the canonical playbook catalogs as versioned control-plane data:

```bash
./bin/revo.js playbook install ../agents --dry-run
./bin/revo.js playbook install ../agents --commit
```

This installs playbook, role, and pipeline metadata for later route proposal and workflow-as-data work. The current
MVP workflow still executes the DBOS `developTask` code path.

**Re-running `bootstrap --commit`** is safe: it is create-or-skip (identical rows are silently
skipped, no duplicates). It is NOT an update — if you later edit a seeded row in Revisium and
re-run `bootstrap --commit`, it will conflict-throw on the drift and will NOT overwrite your
change. To evolve an already-committed seed row, first edit (or delete) that row in Revisium,
then re-run `bootstrap --commit`.

## Step 2 — create a run and start the pipeline (stub path, zero cost)

Point at a repo with `--repo <path>` (required) and name the task with `--title <text>` (required).
There is no separate project-create step — a run is created and pointed at a repo directly via
`--repo`; no project object to create in the alpha.

```bash
./bin/revo.js run create --title "my task" --repo . --start --stub --wait
```

This single command:
1. Creates the run in Revisium (mints a fresh `runId` — shown in the output).
2. Boots the in-CLI NestJS/DBOS host (ensure-Revisium → ensure `dbos` db → DBOS launch → ready).
3. Enqueues the durable `developTask` workflow (architect → developer → reviewer → integrator).
4. Attaches a live viewer that polls until the run parks at the **plan gate**, then prints:

```text
parked:   run <runId> is waiting at the 'plan' gate
          resolve with: revo inbox resolve <gateId> --approve|--reject
```

**Re-attach note:** the `runId` printed in step 1 is the only identifier for this run.
To re-attach later (e.g. after a Ctrl-C), use `run start <thatId> --wait` — never a fresh
`run create`, which always mints a NEW run.

## Step 3 — resolve the plan gate

```bash
./bin/revo.js inbox list                                      # find the pending gate row
./bin/revo.js inbox resolve <gateId> --approve --wait        # approve + stay attached
```

With `--wait` the CLI stays attached through the developer/reviewer/integrator steps and surfaces
the **merge gate** prompt when the integrator finishes. Without `--wait` you may see a ~20s timeout
note before the merge gate opens — re-attach with:

```bash
./bin/revo.js run start <runId> --wait
```

## Step 4 — resolve the merge gate

```bash
./bin/revo.js inbox list                                      # find the merge gate row
./bin/revo.js inbox resolve <gateId> --approve               # approve to finish
```

Stub run: `prUrl = stub://pr/placeholder`.
Live run: a real draft PR URL.

## Live path (optional — costs money + makes real git changes)

```bash
./bin/revo.js run create --title "my task" --repo . --start --wait --live
```
> For installed users: `revo run create --title "my task" --repo /path/to/repo --start --wait --live`

> WARNING: --live runs real Claude (claude -p) and incurs token cost on
> architect/developer/reviewer, AND the real integrator will push a branch and open a draft PR.

Requires `gh` auth and a clean target repo (preflight blocks a dirty repo).

## MCP entry

`revo mcp` starts the local stdio MCP server. It is meant to be launched by a
local MCP-capable agent, not by a browser:

```json
{
  "mcpServers": {
    "revo": {
      "command": "/path/to/agent-orchestrator/bin/revo.js",
      "args": ["mcp"]
    }
  }
}
```

The MCP server has no auth because it is local stdio only. It exposes product
tools for task development control: health, repository diagnostics, run
create/start/resume/cancel, run digests, inbox gate approval/rejection,
playbook install/discovery, role/pipeline discovery, and route simulation.

It does not expose generic Revisium table CRUD. Use the product tools so the
same Nest/DBOS/Revisium core owns workflow starts, gate signals, and data-access
boundaries.

## Where state lives

```text
~/.revisium-orchestrator/
├── pgdata/          # embedded PostgreSQL (both Revisium DB + DBOS DB live here)
├── jwt-secret       # generated internal JWT secret
├── uploads/         # local file uploads
├── runtime.json     # { httpPort, pgPort, pid, startedAt } — written by `start`
└── standalone.log   # daemon stdout/stderr
```

**DBOS progress state lives in the `dbos` Postgres database** inside the embedded Postgres —
NOT in Revisium, NOT in a file. This state is durable across CLI restarts.

**Resume / re-attach:** `run start <existingRunId> --wait` — idempotent by `workflowID=runId`.
This resumes the SAME durable workflow from where it paused, with no duplicated steps or PRs.
A fresh `run create` (with or without `--start`) ALWAYS mints a new `runId` and starts a NEW run
— it is NOT a resume path.

## Ctrl-C safety

Pressing Ctrl-C on the `--wait` viewer preserves the run's durable state — it does NOT cancel
the workflow.

Because the host runs inside the CLI process, if this was the only host then **progress pauses**
on Ctrl-C (it does not keep running). The viewer returns cleanly on Ctrl-C so DBOS shuts down
normally via `app.close()`.

Resume with `revo run start <runId> --wait` — **not** `run show <runId>`, which is read-only and
does not boot a host or resume progress.

## Reset everything

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
```

This wipes both the Revisium database AND the `dbos` database, since they share the embedded
Postgres.

## Next

- The system in one page: [architecture-overview.md](./architecture-overview.md)
- The tables you just created: [control-plane-schema.md](./control-plane-schema.md)
- Gate mechanics: [inbox-and-gates.md](./inbox-and-gates.md)
