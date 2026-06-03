# Role-context — agent-orchestrator

Repo-specific values for the project-agnostic role prompts in
`anton62k/agents` → `prompts/orchestrator-roles/`. Fill the `{{PLACEHOLDERS}}`
in a role prompt from this table before running that role.

> **This file is committed to a PUBLIC repo.** Keep it free of private data:
> no absolute/home paths, no account names, no tokens. Private values (gh
> account, machine paths) go in a gitignored `*.local.md` override — see below.

## Placeholders (public-safe)

| Placeholder | Value |
| --- | --- |
| `{{REPO}}` | this repository's root (the directory where this repo is cloned) |
| `{{GH_REPO}}` | `revisium/agent-orchestrator` |
| `{{BASE_BRANCH}}` | `master` |
| `{{INVARIANTS_DOC}}` | `docs/architecture-overview.md` (the five invariants) |
| `{{TYPECHECK_CMD}}` | `npm run typecheck` |
| `{{TEST_CMD}}` | `npm test` |
| `{{LINT_CMD_OR_NONE}}` | `npm run lint:ci` |
| `{{COMMIT_RULES}}` | single clean commit; **no** `Co-Authored-By`; **no** AI-attribution / summary footer |
| `{{PR_TITLE}}` | `Implement Plan NNNN <short name>` (matches existing PR history) |
| `{{BRANCH}}` | `feat/plan-NNNN-<slug>` |
| `{{GH_ACCOUNT}}` | **not stored here** — supply at run time from the gitignored local override (see below) |
| `{{BOTS}}` | CodeRabbit + Gitar (PR reviews) + SonarCloud (quality gate). CodeRabbit's CI check often shows "review skipped" — always read its real review via the API. |
| `{{SONAR_PROJECT_HINT}}` | resolve via `.sonarlint/connectedMode.json` → sonar config → else list SonarQube projects for this repo |

## Private values (do NOT commit)

Values that are account- or machine-specific live in `role-context.local.md`
(gitignored). Create it locally with whatever the role needs, e.g. the gh
account to push/PR with. The prompts read `{{GH_ACCOUNT}}` from there.

## Control plane (for context-building / inspection roles)

Coordinates, ports, and the versioned/runtime table split are documented in
`AGENTS.md` and `docs/control-plane-schema.md` — do not duplicate them here.
The resolved port lives in the local `runtime.json`; never hardcode it.

## Notes

- The chain and per-role prompts: `prompts/orchestrator-roles/README.md`.
- Calibration the reviewer/watcher must apply:
  `practices/bot-review-calibration.md` (mirrors KB decision
  `role-chain-calibration-lessons-v1`).
- The eventual automated equivalent of this manual chain is Plans 0006 (verbs)
  → 0007 (dumb loop) → 0008 (real `claude -p` runner); the same role prompts can
  seed `roles.system_prompt` once the runner exists.

## Local quality gates

Before every PR, run:
- `npm run verify` — typecheck + lint:ci + test (full local gate)
- `npm run sonar:issues:local` — inspect unresolved SonarCloud issues for the current branch/PR
  (requires SONAR_TOKEN in `.env.sonar`; copy `.env.sonar.example` to get started)
- `npm run sonar:local` — full Sonar scan via Docker (needs Docker + SONAR_TOKEN)
- `npm run ci:local:sonar` — full pipeline: verify → sonar:local → sonar:issues:local
