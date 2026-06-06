# AGENTS.md — agent-orchestrator

Repo-local context for coding agents (Claude Code, etc.). `CLAUDE.md` is a symlink to this file.

## Method vs. context

Reusable **method** (prompts, skills, practices) lives in the `../agents` repo (`anton62k/agents`) —
"project repos contain context; `agents` contains method." This repo keeps **project context + code**.
Project-local operational skills live in [`.agents/skills/`](./.agents/skills/).

## What this is

A **NestJS host** that runs dev tasks via short-lived AI agents (roles are *data*, not code). Durable execution is
handled by **DBOS** (a durable-workflow engine on Postgres) — not a hand-rolled loop. **Revisium is the source of
truth for *meaning*** (roles, policy, inbox, events, domain); **DBOS is the source of truth for *progress***.
Read [`docs/architecture-overview.md`](./docs/architecture-overview.md) and
[`docs/adr/0001-execution-engine-and-host.md`](./docs/adr/0001-execution-engine-and-host.md) first — they hold the
invariants you must not break.

> The pre-pivot "thin dumb loop" code (`src/worker/loop.ts`, step-lifecycle verbs) still exists but is **legacy**,
> superseded by DBOS; do not extend it. See the roadmap.

## Local facts

- **Stack:** TypeScript / Node **`>=24.11.1 <25`**. Host: **NestJS 11** (house stack). Engine:
  **DBOS** (`@dbos-inc/dbos-sdk`).
- **Control plane:** local standalone Revisium via the `revo` CLI. Preferred port `19222` (pg `15440`); the
  **resolved** port lives in `~/.revisium-orchestrator/runtime.json` — never hardcode it. Coordinates:
  `admin/control-plane/master`.
- **One Postgres:** Revisium standalone owns the embedded Postgres; DBOS connects as a `pg` client to a separate
  `dbos` database on the same server (no second Postgres). MVP = two processes (standalone daemon + host).
- **Run:** `./bin/revo.js revisium start` → `./bin/revo.js bootstrap --commit`
  (see [`docs/getting-started.md`](./docs/getting-started.md)).
- **Source-of-truth boundary:** Revisium holds meaning (versioned: ADRs/roles/policy; draft: inbox/events/cost);
  DBOS holds progress (never in Revisium). See [`docs/control-plane-schema.md`](./docs/control-plane-schema.md).

## Map

- Docs index + roadmap: [`docs/README.md`](./docs/README.md) · [`docs/roadmap.md`](./docs/roadmap.md)
- Architecture & invariants: [`docs/architecture-overview.md`](./docs/architecture-overview.md)
- Decision record (engine + host): [`docs/adr/0001-execution-engine-and-host.md`](./docs/adr/0001-execution-engine-and-host.md)
- Build slices (work-orders): [`docs/plans/`](./docs/plans/)
- Local skills: [`.agents/skills/run-revisium`](./.agents/skills/run-revisium/SKILL.md) ·
  [`.agents/skills/bootstrap-control-plane`](./.agents/skills/bootstrap-control-plane/SKILL.md)
