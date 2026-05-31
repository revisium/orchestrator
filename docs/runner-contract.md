# Runner contract (runAgent)

> **Status: DRAFT.** The Claude Code headless branch is the MVP; Codex is a later branch of the same function.
> **Depends on:** [repo-layer-contract.md](./repo-layer-contract.md) (the loop calls `runAgent`; `attemptId`
> generated before the run) · [control-plane-schema.md](./control-plane-schema.md) (`roles.runner`,
> `allowed_tools`, `model_profiles`) · [context-budget.md](./context-budget.md) (the context input).
> **Realized by:** brief §4 / §9, built as a slice after the data-access layer (Plan TBD).

All runner specifics hide behind **one** function. The loop is runner-agnostic.

```ts
runAgent(role: Role, profile: ModelProfile, context: string, attemptId: string, step: Step)
  : Promise<AttemptResult>   // { output, artifacts, nextSteps, costs, needsHuman?, lesson? }
```

## Behavior

- **Dispatch by `role.runner`:** `claude-code` (MVP) → headless `claude -p "<context>" --model <profile.model_id> …`
  in the target repo; `codex` → non-interactive Codex (later, second branch of this same function).
- **Isolation:** run in a fresh clone / container, with only the tools in `role.allowed_tools` enabled.
- **Idempotency on external effects:** `attemptId` / `idempotency_key` is generated **before** the run (see
  [repo-layer-contract.md](./repo-layer-contract.md)). External actions (create PR / commit) must be
  "create only if this key hasn't been used" — a worker can die mid-step; never double-create.
- **Timeout:** kill a runner that exceeds N minutes and return the step to `ready`/inbox — otherwise one hung
  step freezes the single sequential worker.
- **`needsHuman`:** a runner may signal a blocker/approval instead of a result; the loop then `pushInbox`s and the
  branch parks (it does not write `nextSteps`).
- **`lesson`:** on failure, return the compressed takeaway for the next attempt's context.

## Hard rules

- **Do NOT depend on undocumented CLI flags.** CLI capability/versions drift; all CLI-specific code lives only
  inside `runAgent`. Capability negotiation stays here, never leaks to the loop.
- **Verify by hand before coding:** `claude -p "…" --model <…>` must run without a dialog and return a result a
  script can capture. That round-trip is the foundation of the loop.
- The developer agent must not change architecture/ADRs on its own initiative — that constraint lives in the
  role's `system_prompt`, enforced by scope, not by the runner.
