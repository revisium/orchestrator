# Plan 0005 — Real runners + integrator to PR

> **Status: Draft.** Swaps the stub for a real Claude Code runner and makes the integrator open a PR.
> **Depends on:** [0003](./0003-dbos-pipeline-workflow.md) · [0004](./0004-human-gates-via-dbos-inbox.md) ·
> [runner-contract.md](../runner-contract.md).
> **Realizes:** the first real (non-stub) end-to-end run.

## Scope

Wire the Claude Code runner as a Nest service so analyst/developer/reviewer steps run real agents, and make the
integrator step create a branch, commit, and open a draft PR — idempotently.

## Non-goals

- No CI/Sonar/CodeRabbit polling (post-MVP; `src/poller/pr-readiness.ts` exists, wire later).
- codex review is optional here (read-only wrapper), not required for the MVP gate.

## Files to create / change

- `src/runners/claude-code.service.ts` — Nest provider wrapping `createClaudeCodeRunner`; injects a
  `ProcessExecutor` and a `resolveCwd(step)` (target repo path from run input).
- `src/runners/runner.module.ts` — provides `RunAgent` via `createRunAgent({ claudeCode, script })`; dispatch on
  `role.runner`.
- `src/runners/integrator.ts` — branch (`fresh master` → feature branch), commit (no co-author), push, find-or-
  create PR by head branch (idempotent), return PR url into the workflow for the merge gate.
- `src/pipeline/develop-task.workflow.ts` — integrator step calls `integrator.ts`; reviewer step may invoke codex
  via the read-only wrapper (optional).

## Reference code (reuse as-is)

- `src/worker/claude-code-runner.ts` (`createClaudeCodeRunner`) — flags, stdin context, JSON parse.
- `src/worker/process-executor.ts` (`spawnExecutor`, `ProcessExecutor`) — process spawn + timeout (test seam).
- `src/worker/result-envelope.ts` (`REVO_RESULT_CONTRACT`, `parseTransportEnvelope`, `extractAgentResult`).
- `src/worker/runner-dispatch.ts` (`createRunAgent`), `src/worker/script-runner.ts`.
- PR-identity / idempotent integrator concept from the dropped `0017` (recover from `git log` if needed).

## Tasks

1. `ClaudeCodeService` + `RunnerModule`; dispatch real `claude-code` runner; cost recorded from the envelope.
   **Verify:** an analyst step runs a real `claude -p`, returns a parsed `AttemptResult`, cost logged to Revisium.
2. Integrator: branch from fresh `origin/master`, commit (no co-author), push, find-or-create draft PR.
   **Verify:** integrator opens a draft PR once; re-running the step finds the same PR, does not duplicate.
3. Feed the PR url into the merge gate (0004).
   **Verify:** the merge-gate inbox row carries the real PR url.

## Acceptance test

- A small real ticket runs analyst→developer→reviewer→integrator with the Claude Code runner and opens a **draft
  PR**, parking at the merge gate.
- The integrator is idempotent (re-run → same PR).
- `npm run lint:ci` + `tsc` clean.
