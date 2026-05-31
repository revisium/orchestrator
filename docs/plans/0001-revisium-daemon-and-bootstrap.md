# Plan 0001 — Revisium daemon CLI + control-plane bootstrap + docs

> **Audience:** an implementing coding agent (low-capability model). Follow the steps **in order**.
> Each step lists the exact files to create, reference code, and a **Verify** command that must pass
> before moving on. Do not skip Verify. Do not invent flags or APIs — when unsure, read the referenced
> file. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** start/stop/status/logs daemon control for a local standalone Revisium, plus a
> declarative control-plane bootstrap, plus docs and skills. **Out of scope:** the `@revisium/client`
> data-access layer, the worker loop, runners, seeding roles/model_profiles with real prompts. Those are
> later slices — do not build them.

---

## 0. Context you must read first (do not skip)

Read these real files before writing any code. They are the ground truth for the two external tools:

- `/Users/anton/projects/revisium/revisium/standalone/README.md` — the standalone server (the daemon target).
- `/Users/anton/projects/revisium/revisium-cli/README.md` — the CLI used for bootstrap.
- `/Users/anton/projects/revisium/revisium-cli/docs/bootstrap-commands.md` — `example bootstrap` reference.
- `/Users/anton/projects/revisium/revisium-cli/examples/quickstart/bootstrap.config.json` — the config format to copy.

Key facts (already confirmed — but re-verify if a command fails):

1. **Standalone** is the local Revisium server: an npm package `@revisium/standalone`.
   - Starts an embedded PostgreSQL + HTTP server. **No auth by default.**
   - REST + Swagger at `http://localhost:<port>/api`, GraphQL at `/graphql`, MCP at `/mcp`, Admin UI at `/`.
   - **Ports:** standalone autodiscovers only when `--port`/`--pg-port` are omitted, and it always probes
     **upward from 9222 (HTTP) / 5440 (pg)**. We deliberately avoid that base: **9222 is reserved** for a
     manually-run standalone instance (and it is also Chrome's remote-debugging port). So the orchestrator uses
     **preferred ports HTTP `19222` / pg `15440`** and does its **own** upward free-port scan from those (see §4).
     The resolved ports are written to a runtime state file; **nothing hardcodes a port number**.
   - It is a **foreground** process. **SIGTERM / Ctrl+C = graceful shutdown** (it checkpoints and stops pg cleanly).
   - **Node requirement: `>=24.11.1 <25`.** The executor MUST run Node 24. Verify in step 1.
2. **revisium-cli** (`npx revisium`) does declarative bootstrap against a no-auth instance:
   ```bash
   npx revisium example bootstrap \
     --config ./control-plane/bootstrap.config.json \
     --url revisium://localhost:<resolvedHttpPort>/admin/control-plane/master \
     --skip-auth --commit
   ```
   `--skip-auth` is required because standalone runs without auth. `admin` is the seeded org/owner.
   `<resolvedHttpPort>` comes from the runtime state file (§4), not a constant.

### Versioning boundary (important — affects later slices, not this one)

Revisium has revisions (commits) and branches. This slice **commits once**: creating the control-plane
**table schemas** is a structural/ADR-worthy change, so `bootstrap` uses `--commit`. Later slices will write
**runtime rows** (step statuses, inbox, events) to the **draft** revision and will **NOT** commit per write —
committing high-frequency runtime data would explode the revision count. Do not add per-write commits anywhere.

---

## 1. Environment checks (before any code) — STOP on failure

Run each. If any fails, stop and report; do not work around it.

```bash
node --version           # MUST be >= v24.11.1 and < v25
npx -y @revisium/standalone@latest --help    # prints CLI options (downloads on first run)
npx revisium --help                          # revisium-cli is reachable
```

**Verify:** `node --version` is in range and both `--help` outputs print without error.

---

## 2. Target repo and final layout

All work happens in **`/Users/anton/projects/revisium/agent-orchestrator`** (an existing git repo, currently
only `LICENSE` + `README.md`). Create exactly this layout:

Files marked **(exists)** are already created — do **not** recreate them; the rest are yours to add.

```text
agent-orchestrator/
├── AGENTS.md                         # (exists) repo-local context → ../agents method repo
├── CLAUDE.md -> AGENTS.md            # (exists) symlink
├── .agents/
│   └── skills/                       # (exists) local operational skills
│       ├── run-revisium/SKILL.md
│       └── bootstrap-control-plane/SKILL.md
├── package.json                      # ESM, Node 24, deps below
├── tsconfig.json
├── revisium.config.json              # daemon + bootstrap settings (committed)
├── bin/
│   └── revo.js                       # node shim → dist/cli/index.js
├── src/
│   └── cli/
│       ├── index.ts                  # commander entry, registers subcommands
│       ├── config.ts                 # load revisium.config.json + resolve paths
│       └── commands/
│           ├── revisium.ts           # start | stop | status | logs
│           └── bootstrap.ts          # bootstrap
├── control-plane/
│   └── bootstrap.config.json         # the 10 control-plane tables (step 7)
└── docs/
    ├── getting-started.md            # (exists, DRAFT) finalize/verify against the built CLI
    └── control-plane-schema.md       # (exists, DRAFT) keep in sync with bootstrap.config.json
```

> Skills, `AGENTS.md`/`CLAUDE.md`, and the two docs above already exist (see the repo). This plan only needs to
> create the code (`package.json`, `src/`, `bin/`, config) and `control-plane/bootstrap.config.json`, then
> **finalize/verify** the two DRAFT docs against the real CLI.

---

## 3. Package + TypeScript setup

### `package.json`

```json
{
  "name": "agent-orchestrator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.11.1 <25" },
  "bin": { "revo": "./bin/revo.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "revo": "tsx src/cli/index.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@revisium/standalone": "^2.7.2",
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

Notes for the executor:
- `@revisium/standalone` is a **devDependency** so we spawn its bin **directly** (deterministic pid, no per-start
  download). Do **not** spawn `npx @revisium/standalone` from code — that wrapper process makes the pid unreliable.
- During dev, run commands via `npm run revo -- <args>`. After `npm run build`, `./bin/revo.js <args>` also works.
- Run `npm install` once after writing `package.json` (this installs standalone's native deps: embedded-postgres,
  sharp, bcrypt).

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

### `bin/revo.js`

```js
#!/usr/bin/env node
import '../dist/cli/index.js';
```

Make it executable: `chmod +x bin/revo.js`.

**Verify:** `npm install` succeeds, then `npm run typecheck` passes (after step 5 files exist).

---

## 4. Configuration, runtime state, and port resolution

### `revisium.config.json` (committed — *preferred* ports, not guaranteed ports)

```json
{
  "host": "localhost",
  "preferredPort": 19222,
  "preferredPgPort": 15440,
  "autoDiscover": true,
  "dataDir": "~/.revisium-orchestrator",
  "org": "admin",
  "project": "control-plane",
  "branch": "master"
}
```

### `runtime.json` (NOT committed — written by `start`, read by everything else)

Lives at `${dataDir}/runtime.json`. Add `runtime.json` patterns to `.gitignore` only if dataDir were inside the
repo — here it is under `~`, so nothing to ignore. Shape:

```json
{ "httpPort": 19222, "pgPort": 15440, "pid": 12345, "startedAt": "2026-05-31T12:00:00.000Z" }
```

### `src/cli/config.ts` — responsibilities

- Read `revisium.config.json` from the repo root; expand a leading `~` in `dataDir` to `os.homedir()`.
- Ensure `dataDir` exists (`fs.mkdirSync(dataDir, { recursive: true })`).
- Export **static** paths/values: `logFile = ${dataDir}/standalone.log`,
  `runtimeFile = ${dataDir}/runtime.json`, plus `host`, `org`, `project`, `branch`, `preferredPort`,
  `preferredPgPort`, `autoDiscover`. (No separate pid file — `runtime.json` holds `pid` + resolved ports, so
  there is a single source of truth.)
- Export a `resolvePorts()` helper that returns the **live** ports:
  - If `runtime.json` exists and its `pid` is alive → return its `httpPort`/`pgPort`.
  - Else → return the preferred ports.
- Export **port-derived** helpers as functions of an http port (do **not** bake a constant):
  - `baseUrl(port) = http://${host}:${port}`
  - `healthUrl(port) = ${baseUrl(port)}/api`
  - `revisiumUri(port) = revisium://${host}:${port}/${org}/${project}/${branch}`
- Export `findFreePort(from: number): Promise<number>` — scan upward from `from`, return the first port where a
  `net.createServer().listen(port)` succeeds (then close it). Use it for both HTTP and pg discovery.

```ts
import { createServer } from 'node:net';

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) if (await isPortFree(p)) return p;
  throw new Error(`No free port found from ${from}`);
}
```

---

## 5. The CLI — `src/cli/index.ts`

Use `commander`. Register a top-level program `revo` with:
- a `revisium` command group: `start`, `stop`, `status`, `logs`
- a `bootstrap` command

```ts
import { Command } from 'commander';
import { registerRevisium } from './commands/revisium.js';
import { registerBootstrap } from './commands/bootstrap.js';

const program = new Command();
program.name('revo').description('Agent orchestrator CLI').version('0.0.1');
registerRevisium(program);
registerBootstrap(program);
program.parseAsync(process.argv);
```

---

## 6. `src/cli/commands/revisium.ts` — daemon control

Implement four subcommands under `revo revisium ...`. Reference implementations below — adapt names to your
config loader. Use **only** Node built-ins (`node:child_process`, `node:fs`, `node:os`, `node:net`, global
`fetch`). **No command hardcodes a port** — `start` resolves and persists ports; the others read `runtime.json`.

### `revo revisium start [--port <n>] [--pg-port <n>] [--data <dir>]`

`--port` / `--pg-port` override the preferred ports for this run (still scanned upward if busy unless you treat
the flag as a hard pin — your choice; default to scan-from-flag). Behavior:

1. If `runtime.json` exists, its `pid` is alive, **and** the health probe on its `httpPort` passes →
   print `already running on http://localhost:<httpPort>` and exit 0.
2. If `runtime.json` exists but the pid is dead → delete the stale `runtime.json` and continue.
3. **Resolve ports** (this is the autodiscovery): pick a base from the flag or `preferredPort`/`preferredPgPort`,
   then `httpPort = await findFreePort(baseHttp)` and `pgPort = await findFreePort(basePg)`. These are what we
   pass to standalone, so we know them exactly.
4. Resolve the standalone entry script and spawn it **detached**, redirecting output to the log file, then
   persist resolved ports + pid to `runtime.json`:

```ts
import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const entry = require.resolve('@revisium/standalone/bin/revisium-standalone.js');

const out = openSync(logFile, 'a');
const child = spawn(
  process.execPath,
  [entry, '--port', String(httpPort), '--pg-port', String(pgPort), '--data', dataDir],
  { detached: true, stdio: ['ignore', out, out] },
);
child.unref();
writeFileSync(
  runtimeFile,
  JSON.stringify({ httpPort, pgPort, pid: child.pid, startedAt: new Date().toISOString() }, null, 2),
);
```

> Note on the rare TOCTOU race: a port found free in step 3 could be taken before standalone binds it. With an
> explicit `--port`, standalone then exits; `start` will see health never comes up, report the failure, and the
> user just re-runs `start` (it scans to the next free port). Acceptable for a single-user local MVP.

5. Poll health until ready or timeout, using the **resolved** `httpPort`.
   **First run downloads/initialises PostgreSQL — allow up to 120s.**

```ts
async function waitHealthy(healthUrl: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;        // /api serves Swagger → 200
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
```

6. On healthy → print the URLs for the resolved port (Admin `http://localhost:<httpPort>/`, REST `/api`,
   GraphQL `/graphql`, MCP `/mcp`) and the pid, exit 0.
7. On timeout → print the **last ~20 lines of the log file**, attempt stop (step `stop` logic), exit 1.

### `revo revisium stop`

1. If no `runtime.json` → print `not running`, exit 0.
2. Read `pid` from `runtime.json`. Send `SIGTERM` to the **process group** first (covers embedded-postgres
   child), then fall back to the single pid; SIGTERM is graceful (pg checkpoint):

```ts
function killTree(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); }       // negative pid = process group (detached leader)
  catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}
```

3. Wait up to 20s for the process to exit (poll `isAlive(pid)`). If still alive → `killTree(pid, 'SIGKILL')`.
4. Delete `runtime.json`. Print `stopped`.

```ts
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

### `revo revisium status`

Read `runtime.json` (for `pid` + `httpPort`). Print one of:
- `running (pid <n>) on http://localhost:<httpPort> — health OK` (runtime.json + alive + health passes)
- `running (pid <n>) on http://localhost:<httpPort> but health FAILING` (alive but `/api` not 2xx/3xx)
- `stopped` (no `runtime.json`, or pid dead → also clean the stale `runtime.json`)

### `revo revisium logs [-n <lines>] [-f]`

- Default: print last `-n` (default 50) lines of the log file.
- `-f`: follow/tail (you may implement with `fs.watch` or by spawning `tail -f`; keep it simple, `tail` is fine).

**Verify (run these, in order):**
```bash
npm run build
./bin/revo.js revisium start      # first run may take ~60-120s; prints the resolved port (expect :19222)
./bin/revo.js revisium status     # → running on http://localhost:19222 ... health OK
PORT=$(node -e "console.log(require('os').homedir()+'/.revisium-orchestrator/runtime.json')" \
  | xargs cat | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).httpPort))")
curl -s http://localhost:$PORT/api | head -c 200   # Swagger HTML
./bin/revo.js revisium logs -n 20
./bin/revo.js revisium stop       # → stopped
./bin/revo.js revisium status     # → stopped
```
(The `PORT=...` line just reads `httpPort` out of `runtime.json`; if `start` printed the port, use that instead.)

---

## 7. Control-plane schema — `control-plane/bootstrap.config.json`

This is the §5 control-plane model expressed in revisium-cli bootstrap format (copy the structure from
`/Users/anton/projects/revisium/revisium-cli/examples/quickstart/bootstrap.config.json`). Ten tables, **no seed
rows** in this slice (`rows: []`), REST endpoint enabled.

Field-type rules:
- Identity is the Revisium **rowId** — you do not need a separate primary-key column, but keeping an `id` string
  field is harmless and matches §5; include it.
- Status / enum-like fields → `{ "type": "string" }` (no `enum` for MVP; list allowed values in `description`).
- Timestamps → `{ "type": "string" }` (ISO-8601).
- Integers (counts, tokens, priority) → `{ "type": "number" }`.
- Booleans → `{ "type": "boolean" }`.
- Arrays of strings (`repos`, `depends_on`, `allowed_tools`, `options`) → `{ "type": "array", "items": { "type": "string" } }`.
- **Free-form JSON** (`input`, `output`, `payload`, `context`, `scope_rules`, `params`, `rule`, `answer`) →
  `{ "type": "object", "additionalProperties": true }`. If Revisium rejects `additionalProperties: true` on
  bootstrap, fall back to `{ "type": "string" }` (store serialised JSON) and note it in your report.

Use this exact file content (adjust only if a Verify step proves a type is rejected):

```json
{
  "projectName": "control-plane",
  "branchName": "master",
  "endpoints": ["REST_API"],
  "tables": [
    {
      "id": "task_runs",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "project_id": { "type": "string", "default": "" },
          "title": { "type": "string", "default": "" },
          "description": { "type": "string", "default": "" },
          "status": { "type": "string", "default": "pending", "description": "pending|planning|ready|running|completed|failed|awaiting_approval|paused|cancelled" },
          "repos": { "type": "array", "items": { "type": "string" }, "default": [] },
          "scope": { "type": "string", "default": "" },
          "priority": { "type": "number", "default": 0 },
          "created_by": { "type": "string", "default": "" },
          "created_at": { "type": "string", "default": "" },
          "updated_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "tasks",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "run_id": { "type": "string", "default": "" },
          "repo_ref": { "type": "string", "default": "" },
          "role_hint": { "type": "string", "default": "" },
          "title": { "type": "string", "default": "" },
          "status": { "type": "string", "default": "pending" },
          "depends_on": { "type": "array", "items": { "type": "string" }, "default": [] },
          "scope": { "type": "string", "default": "" },
          "priority": { "type": "number", "default": 0 },
          "created_at": { "type": "string", "default": "" },
          "updated_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "steps",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "task_id": { "type": "string", "default": "" },
          "run_id": { "type": "string", "default": "" },
          "role": { "type": "string", "default": "" },
          "kind": { "type": "string", "default": "" },
          "status": { "type": "string", "default": "pending", "description": "pending|ready|claimed|running|succeeded|failed|dead|awaiting_approval|skipped" },
          "input": { "type": "object", "additionalProperties": true, "default": {} },
          "output": { "type": "object", "additionalProperties": true, "default": {} },
          "model_profile": { "type": "string", "default": "" },
          "run_after": { "type": "string", "default": "" },
          "attempt_count": { "type": "number", "default": 0 },
          "max_attempts": { "type": "number", "default": 3 },
          "priority": { "type": "number", "default": 0 },
          "lease_owner": { "type": "string", "default": "" },
          "lease_expires_at": { "type": "string", "default": "" },
          "dead_reason": { "type": "string", "default": "" },
          "created_at": { "type": "string", "default": "" },
          "updated_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "attempts",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "step_id": { "type": "string", "default": "" },
          "run_id": { "type": "string", "default": "" },
          "worker_id": { "type": "string", "default": "" },
          "attempt_no": { "type": "number", "default": 0 },
          "status": { "type": "string", "default": "" },
          "idempotency_key": { "type": "string", "default": "" },
          "model_profile": { "type": "string", "default": "" },
          "input_tokens": { "type": "number", "default": 0 },
          "output_tokens": { "type": "number", "default": 0 },
          "lesson": { "type": "string", "default": "" },
          "error": { "type": "string", "default": "" },
          "started_at": { "type": "string", "default": "" },
          "finished_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "events",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "run_id": { "type": "string", "default": "" },
          "task_id": { "type": "string", "default": "" },
          "step_id": { "type": "string", "default": "" },
          "type": { "type": "string", "default": "" },
          "payload": { "type": "object", "additionalProperties": true, "default": {} },
          "actor": { "type": "string", "default": "" },
          "created_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "inbox",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "kind": { "type": "string", "default": "", "description": "approval|question|alert" },
          "run_id": { "type": "string", "default": "" },
          "task_id": { "type": "string", "default": "" },
          "step_id": { "type": "string", "default": "" },
          "project_id": { "type": "string", "default": "" },
          "title": { "type": "string", "default": "" },
          "context": { "type": "object", "additionalProperties": true, "default": {} },
          "options": { "type": "array", "items": { "type": "string" }, "default": [] },
          "status": { "type": "string", "default": "pending", "description": "pending|resolved" },
          "answer": { "type": "object", "additionalProperties": true, "default": {} },
          "resolved_by": { "type": "string", "default": "" },
          "created_at": { "type": "string", "default": "" },
          "resolved_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "roles",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "name": { "type": "string", "default": "", "description": "architect|developer|tester|reviewer|integrator|triage" },
          "system_prompt": { "type": "string", "default": "" },
          "model_level": { "type": "string", "default": "standard", "description": "cheap|standard|deep" },
          "effort": { "type": "string", "default": "" },
          "runner": { "type": "string", "default": "claude-code", "description": "claude-code|codex" },
          "allowed_tools": { "type": "array", "items": { "type": "string" }, "default": [] },
          "scope_rules": { "type": "object", "additionalProperties": true, "default": {} },
          "updated_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "model_profiles",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "level": { "type": "string", "default": "", "description": "cheap|standard|deep" },
          "provider": { "type": "string", "default": "" },
          "model_id": { "type": "string", "default": "" },
          "params": { "type": "object", "additionalProperties": true, "default": {} },
          "cost_per_input": { "type": "number", "default": 0 },
          "cost_per_output": { "type": "number", "default": 0 },
          "updated_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "routing_policy",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "rule": { "type": "object", "additionalProperties": true, "default": {} },
          "model_level": { "type": "string", "default": "standard" },
          "requires_human": { "type": "boolean", "default": false },
          "updated_at": { "type": "string", "default": "" }
        }
      }
    },
    {
      "id": "cost_ledger",
      "schema": {
        "type": "object", "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "default": "" },
          "run_id": { "type": "string", "default": "" },
          "step_id": { "type": "string", "default": "" },
          "attempt_id": { "type": "string", "default": "" },
          "model_profile": { "type": "string", "default": "" },
          "input_tokens": { "type": "number", "default": 0 },
          "output_tokens": { "type": "number", "default": 0 },
          "cost_amount": { "type": "number", "default": 0 },
          "currency": { "type": "string", "default": "USD" },
          "recorded_at": { "type": "string", "default": "" }
        }
      }
    }
  ],
  "rows": [],
  "commitMessage": "Bootstrap control-plane schema (plan 0001)"
}
```

> Why `lease_owner` / `lease_expires_at` exist now though unused: adding a field to a fresh schema is free;
> migrating a populated table later is painful (brief §5/§7). Leave them.

---

## 8. `src/cli/commands/bootstrap.ts`

`revo bootstrap [--commit]` (default `--commit` ON; allow `--no-commit` for a dry structural check):

1. Resolve the live `httpPort` via `resolvePorts()`, then check the daemon is healthy (reuse the health probe).
   If not → print `Revisium is not running. Run: revo revisium start` and exit 1.
2. Build `revisiumUri(httpPort)` and shell out to revisium-cli (use `spawn`/`execFile`, inherit stdio so the
   user sees CLI output):
   ```bash
   npx revisium example bootstrap \
     --config <repoRoot>/control-plane/bootstrap.config.json \
     --url <revisiumUri(httpPort)> \
     --skip-auth [--commit]
   ```
   e.g. `--url revisium://localhost:19222/admin/control-plane/master`.
3. Exit with the CLI's exit code.

**Verify** ($PORT = resolved httpPort, e.g. 19222):
```bash
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
```
Then confirm the 10 tables exist. Use one of these — **do not assume an `/api/.../tables` path** (the platform
management API path is unverified; discover it from Swagger if you want it):

1. **Generated REST endpoint (documented).** The bootstrap config enables `REST_API`, so a per-revision endpoint
   exists at `/endpoint/rest/<org>/<project>/<branch>/<revision>/tables/<tableId>`. Probe one known table — a
   `200` with a JSON rows array proves the table is there:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     http://localhost:$PORT/endpoint/rest/admin/control-plane/master/draft/tables/steps   # expect 200
   ```
   Reference: `/Users/anton/projects/revisium/revisium-cli/docs/quickstart.md` (endpoint base URL shape).
2. **Re-run bootstrap (idempotent).** A second `./bin/revo.js bootstrap` should report each of the 10 tables as
   `skipped` / already-exists — that list is your confirmation.
3. **Admin UI (visual, full list).** Open `http://localhost:$PORT/` and confirm the `control-plane` project shows
   all 10 tables: `task_runs, tasks, steps, attempts, events, inbox, roles, model_profiles, routing_policy,
   cost_ledger`.

---

## 9. Docs (`docs/`) — already drafted, **finalize & verify** (do not rewrite from scratch)

`docs/getting-started.md` and `docs/control-plane-schema.md` already exist as DRAFTs. Your job is to **verify
them against the real CLI/schema you just built** and fix any drift, not recreate them:
- `getting-started.md`: run every command in it; correct anything that differs from the built `revo` CLI
  (flags, output, ports). Confirm the data-dir layout matches what `start` actually writes.
- `control-plane-schema.md`: confirm the table/field list matches your final `control-plane/bootstrap.config.json`
  (especially the free-form-JSON encoding you settled on) and the versioned-vs-runtime split.

## 10. Skills — already created, **do not modify** unless behavior changed

`.agents/skills/run-revisium/SKILL.md` and `.agents/skills/bootstrap-control-plane/SKILL.md` already exist
(format mirrors `/Users/anton/projects/agents/skills/pr/SKILL.md`). Only touch them if the CLI you built diverges
from what they describe (e.g. a renamed subcommand) — then update the skill to match.

## 11. `AGENTS.md` / `CLAUDE.md` — already created, **do not recreate**

`AGENTS.md` (+ `CLAUDE.md` symlink) at the repo root already hold the local facts (Node 24, `revo` CLI, ports,
control-plane coordinates, doc map). Update only if your implementation changes a documented fact (e.g. a default
port or command name).

---

## 12. Final acceptance test (the whole slice)

Run from a clean state (`rm -rf ~/.revisium-orchestrator` first if re-testing):

```bash
cd /Users/anton/projects/revisium/agent-orchestrator
npm install
npm run build
npm run typecheck                 # passes, no errors
./bin/revo.js revisium start      # → healthy, prints URLs
./bin/revo.js revisium status     # → running ... health OK
./bin/revo.js bootstrap --commit  # → 10 tables created and committed
./bin/revo.js revisium stop       # → stopped (graceful)
./bin/revo.js revisium start      # → restarts fast, data persisted
./bin/revo.js revisium status     # → running, control-plane still has 10 tables
./bin/revo.js revisium stop
```

**Slice is done when:** all commands above succeed; the Admin UI shows the `control-plane` project with 10
tables after a stop/start cycle (proves persistence); the two DRAFT docs are verified against the built CLI; the
pre-existing `.agents/skills/` and `AGENTS.md` still match the implementation.

---

## 13. Report back / open questions (do NOT silently resolve)

When done, report: what was built, the Verify outputs, and answers to any of these you hit:
1. Did `additionalProperties: true` work for free-form JSON fields, or did you fall back to `string`?
2. Exact REST path that lists tables (you discovered it via Swagger) — record it for the next slice.
3. Any standalone start flakiness / timeout you had to raise.

**Explicitly out of scope (next slices — do not start):** `@revisium/client` data-access layer (§6), worker
loop (§7), runners (§9), seeding `roles`/`model_profiles` with real prompts (§10). Also the brief's open
questions §15 (atomic conditional update, revision mechanics in `@revisium/client`) belong to the data-access
slice — do not investigate them here.
