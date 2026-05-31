# AGENTS.md — agent-orchestrator

Repo-local context for coding agents (Claude Code, etc.). `CLAUDE.md` is a symlink to this file.

## Method vs. context

Reusable **method** (prompts, skills, practices) lives in the `../agents` repo (`anton62k/agents`) —
"project repos contain context; `agents` contains method." This repo keeps **project context + code**.
Project-local operational skills live in [`.agents/skills/`](./.agents/skills/).

## What this is

A thin, **dumb loop** that runs dev tasks via short-lived AI agents (roles are *data*, not code), with **Revisium
as the single source of truth**. Read [`docs/architecture-overview.md`](./docs/architecture-overview.md) first —
it holds the invariants you must not break.

## Local facts

- **Stack:** TypeScript / Node **`>=24.11.1 <25`**.
- **Control plane:** local standalone Revisium via the `revo` CLI. Preferred port `19222` (pg `15440`); the
  **resolved** port lives in `~/.revisium-orchestrator/runtime.json` — never hardcode it. Coordinates:
  `admin/control-plane/master`.
- **Run:** `./bin/revo.js revisium start` → `./bin/revo.js bootstrap --commit`
  (see [`docs/getting-started.md`](./docs/getting-started.md)).
- **Versioning boundary:** commit only schema / ADRs / roles / policy; never version runtime
  (statuses / inbox / events / cost). See [`docs/control-plane-schema.md`](./docs/control-plane-schema.md).

## Map

- Docs index + roadmap: [`docs/README.md`](./docs/README.md) · [`docs/roadmap.md`](./docs/roadmap.md)
- Architecture & invariants: [`docs/architecture-overview.md`](./docs/architecture-overview.md)
- Build slices (work-orders): [`docs/plans/`](./docs/plans/)
- Local skills: [`.agents/skills/run-revisium`](./.agents/skills/run-revisium/SKILL.md) ·
  [`.agents/skills/bootstrap-control-plane`](./.agents/skills/bootstrap-control-plane/SKILL.md)
