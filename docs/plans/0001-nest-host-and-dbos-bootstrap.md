# Plan 0001 — NestJS host + DBOS bootstrap

> **Status: Draft.** First MVP slice. Stands up the host process and proves the Nest↔DBOS seam.
> **Depends on:** [adr/0001-execution-engine-and-host.md](../adr/0001-execution-engine-and-host.md) ·
> [architecture-overview.md](../architecture-overview.md).
> **Realizes:** the host + engine layers of the post-pivot architecture.

## Scope

Convert the entry point from a bare CLI into a **NestJS standalone application** (no HTTP yet) that, on boot,
ensures Revisium is up, connects DBOS to Revisium's embedded Postgres (separate `dbos` database), launches DBOS,
and exposes the existing CLI commands. Prove durable execution with one trivial workflow.

## Non-goals

- No REST/MCP front doors (later).
- No pipeline workflow yet (slice 0003).
- No removal of the legacy loop/verbs yet (post-MVP cleanup).

## Prerequisites

- `@revisium/standalone` runs locally via `revo revisium start` (existing); resolved pg port is in
  `runtime.json` / `pgdata/postmaster.pid`.
- Add deps: `@nestjs/core`, `@nestjs/common`, `@dbos-inc/dbos-sdk`, `pg`. Node `>=24.11.1 <25` (unchanged).

## Files to create / change

- `src/app.module.ts` — root NestJS module; imports `ConfigModule`, `EngineModule`, CLI module.
- `src/host/host.lifecycle.ts` — `OnApplicationBootstrap` (boot order below) + `OnApplicationShutdown`
  (`DBOS.shutdown()`).
- `src/engine/dbos.module.ts` + `src/engine/dbos.service.ts` — owns `DBOS.setConfig`/`launch`/`shutdown`; exposes
  thin verbs (`startWorkflow`, later `signal`). DBOS is the only thing that knows it is DBOS.
- `src/engine/ensure-postgres.ts` — connect to Revisium's PG (creds `revisium:password`, port from runtime),
  `CREATE DATABASE dbos` if absent (idempotent).
- `src/cli/program.ts` — **WRAP**: drive commands through the Nest app context instead of constructing deps ad hoc.
- `src/cli/index.ts` — bootstrap Nest (`NestFactory.createApplicationContext(AppModule)`), then dispatch CLI.
- `bin/revo.js` — unchanged entry; now boots Nest.

## Reference code (reuse, don't reinvent)

- Port/health/runtime resolution: `src/config.ts` — `resolvePorts`, `readRuntime`, `isHealthy`, `revisiumUri`.
- Existing CLI registry + commands: `src/cli/program.ts` (commander). Keep command *logic*; change wiring.

## Boot order (in `host.lifecycle.ts`)

1. Ensure Revisium standalone is up (reuse `isHealthy`/`resolvePorts`); if not, instruct/start via existing
   `revisium start` path.
2. Read resolved **pg port** from `runtime.json`.
3. `ensurePostgres()` → `CREATE DATABASE dbos` if missing.
4. `DBOS.setConfig({ name: 'agent-orchestrator', databaseUrl: postgresql://revisium:password@localhost:<pg>/dbos })`.
5. `DBOS.launch()` (auto-creates DBOS system tables; auto-recovers in-flight workflows).
6. App ready → CLI dispatch.

## Tasks

1. Add deps; create `EngineModule`/`DbosService` with `setConfig`/`launch`/`shutdown` + a `dev:ping` durable
   workflow (one step that logs and returns).
   **Verify:** `revo dev:ping` completes and the workflow row appears in DBOS (via `DBOS` status API).
2. Implement `ensurePostgres` + boot order in `host.lifecycle.ts`.
   **Verify:** fresh start with no `dbos` db creates it; second start is a no-op.
3. Wrap CLI through the Nest app context.
   **Verify:** existing commands (`run create`, `run show`, `inbox list`) still work through Nest.
4. Validate the **Nest↔DBOS seam**: register the workflow on a DI-provided service (instance method), not just a
   static — confirm DBOS resolves it. This is the ADR-0001 risk; document the working pattern in `dbos.service.ts`.
   **Verify:** `dev:ping` invoked via the injected service runs durably.

## Acceptance test

- `revo dev:ping` runs a durable workflow.
- Kill the process **mid-step** (a step with an artificial `DBOS.sleep`); restart → the workflow **resumes** and
  finishes, it does not restart from the top.
- `npm run lint:ci` and `tsc` clean.
