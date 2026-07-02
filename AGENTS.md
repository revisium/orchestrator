# AGENTS.md - agent-orchestrator

Repo-local context for coding agents. `CLAUDE.md` is a symlink to this file.

## Method vs. context

Reusable method lives in the sibling `../agents` checkout. This repository keeps product context, source code,
ADRs, and specs. Do not copy canonical roles or pipelines into this repo's docs.

## What this is

`agent-orchestrator` is the Revo host: a NestJS application that runs short-lived AI-agent steps through DBOS and
stores product meaning in Revisium.

- **DBOS owns progress:** durable workflow cursor, retries, waits, and resume.
- **Revisium owns meaning:** playbooks, roles, pipeline templates, inbox rows, events, costs, and projections.
- **MCP is the agent front door:** local stdio bridge over product tools.
- **GraphQL is the UI/script front door:** local NestJS/Yoga endpoint over the same feature services.
- **CLI is lifecycle-first:** start, stop, status, restart, doctor, logs, and the MCP bridge.

Read [docs/architecture-overview.md](./docs/architecture-overview.md) and the specs in
[docs/specs/](./docs/specs/) before changing runtime contracts.

## Local facts

- Node: `>=24.11.1 <25`.
- Stack: TypeScript, NestJS 11, DBOS, local Revisium standalone, GraphQL Yoga, local stdio MCP.
- Default profile ports: Revisium HTTP `19222`, embedded Postgres `15440`, GraphQL `19223`.
- Dev profile ports: Revisium HTTP `19622`, embedded Postgres `15840`, GraphQL `19623`.
- The resolved runtime state lives under the selected Revo data directory. Do not hardcode resolved ports in code.
- Source-of-truth schema reference: [docs/control-plane-schema.md](./docs/control-plane-schema.md).

## Docs map

- [docs/README.md](./docs/README.md) - docs index and ownership policy.
- [docs/architecture-overview.md](./docs/architecture-overview.md) - invariants and runtime shape.
- [docs/adr/](./docs/adr/) - high-level decision records.
- [docs/specs/](./docs/specs/) - exact durable contracts.
- [docs/getting-started.md](./docs/getting-started.md) - local operator flow.
- [VERIFICATION.md](./VERIFICATION.md) - repo gates and the comment policy (HARD RULE).

There is no canonical docs archive of obsolete work orders. Work orders belong in GitHub Issues or Revo runs; use
git history for old task text.

## Editing rules

- Inspect current source before changing docs that describe runtime behavior.
- Keep ADRs concise; move exact schemas, APIs, validation rules, and examples to specs.
- Do not describe GraphQL graph-shape migration as landed until the full v1 contract is implemented and
  legacy flat/run-scoped roots are removed from `src/api/graphql-api/schema.graphql`.
- Do not edit source code for a docs cleanup unless a generated docs link truly requires it; stop and report
  first.
- `revo-plans` is read-only source material for this cleanup.
- Follow the comment policy in [VERIFICATION.md](./VERIFICATION.md) when editing `src/**/*.ts`. Run
  `pnpm verify` before every merge; the `local/no-dead-pointers` eslint rule (part of `lint:ci`) is part of that gate.

## e2e performance contract

The e2e suite must stay **wait-bounded** (poll-based test waits), never **teardown-bounded**. Each
`*.e2e.test.ts` runs in its own process that boots a real host; two things otherwise make per-file teardown
expensive (~9 s/file, ~125 s across the suite):

- **Process exit.** `harness.close()` shuts down DBOS but not the Revisium/control-plane client handles, so the
  test process would sit waiting for the event loop to drain before exiting. `test:e2e` passes
  `--test-force-exit` so the runner exits as soon as tests finish — a throwaway process's open handles are the
  OS's problem, and durable state lives in Postgres. This reclaims the bulk of the per-file overhead.
- **DBOS shutdown drain.** A workflow parked at a human gate can never drain, so the drain blocks up to
  `SHUTDOWN_DRAIN_TIMEOUT_MS` (8 s in production). `test:e2e` sets `REVO_SHUTDOWN_DRAIN_TIMEOUT_MS=100` to cap
  it; durable state is recovered on the next `launch()`, so skipping the drain loses nothing (recovery does
  NOT depend on the in-memory drain). On a clean home only a couple of files park at teardown, but on a reused
  home with a backlog of parked runs every file pays the full 8 s — so the cap matters most there.

Production leaves `REVO_SHUTDOWN_DRAIN_TIMEOUT_MS` unset → the 8 s default stays in force; `--test-force-exit`
is test-only. Never set the knob to `0` (that means "await the full drain", i.e. hang on a parked gate).

Three more invariants keep the suite fast AND deterministic:

- **Queue tick.** The DBOS dev-tasks dispatcher polls at `REVO_DEV_TASKS_POLL_INTERVAL_MS` (25 ms under
  `test:e2e`; unset in production → SDK default 1000 ms). Without it every run waits ~0.5–1 s before its
  workflow starts (~70 s across the suite).
- **No zombie workflows.** `cancelRun` only patches the run row — it never cancels the DBOS workflow, so a run
  left parked at a gate stays PENDING, is recovered by every later file's boot, and permanently occupies a
  dev-tasks concurrency slot. Once ≥ `REVO_DEV_TASKS_CONCURRENCY` zombies accumulate, the queue starves and
  every later run times out at 'running' (the historical CI tail wedge: recovery F1–F3, seed M1/M1b/M2,
  run-lifecycle). `harness.close()` cancels PENDING/ENQUEUED workflows at the DBOS level (`keepWorkflowsParked`
  opts out — only for teardown-drain, whose subject IS a parked workflow), and `scripts/e2e-setup.ts` resets
  the whole test home on every suite run (a reused draft also degrades the event query into read-after-write
  staleness — flaky event assertions).
- **Settled waits.** `drive.ts` polls at 25 ms but returns only settled states (terminal run row AND terminal
  DBOS workflow status; gates once the inbox row is visible). Do not assert on event counts with a single read
  right after a wait — poll like `assertEventsPresent`/`countEventsSettled` (the draft event query can miss the
  newest row for a beat).

Target wall-clock: `pnpm test:e2e` ≈ 110–135 s. If it regresses toward ~200 s, suspect teardown (a dropped
flag), the queue-tick knob, or zombie accumulation (`Recovering N workflows` climbing per file in the log)
before blaming test bodies. `src/e2e/teardown-drain.e2e.test.ts` guards the drain cap: teardown with a parked
gate must return < 500 ms. The 30 s `WAIT_TIMEOUT_MS` in `drive.ts` is a deliberate stuck-detector — do not
raise it to absorb slowness.
