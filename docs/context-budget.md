# Context budget (buildContext)

> **Status: DRAFT.** Concept is settled; the implementation lands with the data-access layer.
> **Depends on:** [architecture-overview.md](./architecture-overview.md) (state-not-history) ·
> [repo-layer-contract.md](./repo-layer-contract.md) (`buildContext`) ·
> [control-plane-schema.md](./control-plane-schema.md) (`attempts.lesson`, the ADR digest source).
> **Realized by:** brief §8, built in a slice after the data-access layer (Plan 0003, TBD).

Restart cost is set here. We send **state, not history** — there is no dialogue transcript. Four narrow layers,
all pulled from Revisium:

1. **Who I am** — `role.system_prompt` + scope (what's allowed / forbidden).
2. **What we're doing** — the task + a **digest of ADR verdicts** (the decisions, not the reasoning that reached
   them) + which repos are in play.
3. **What's already done** — artifacts / PRs / touched files + the **`lesson`** from this step's prior `attempts`
   (compressed takeaways, not raw logs).
4. **What's right now** — exactly one step (or one comment). The single goal of this run.

## Do not include

Dialogue history · the whole repo (the agent reads it with tools) · other tasks' ADRs · full logs.

## Why this is the cost lever

A short-lived agent re-reads its context every run. Keeping a **live session** is more expensive, not less — the
growing context is re-sent in full each turn. A cheap restart with a fresh narrow context almost always wins (see
[architecture-overview.md](./architecture-overview.md), live-vs-loop). Layers **2 and 3** dominate the bill:

- **Structure ADRs so verdicts extract separately from rationale.** `buildContext` should pull the decision
  without the deliberation. Store ADRs so a "decisions" digest is a cheap read.
- **Compress `lesson` at write time** (`failStep`), not at read time — one or two lines: what was tried, where it
  failed.

## Tune later, by evidence

Do not over-engineer compression on the MVP — assemble the four layers as-is. Then use `cost_ledger`
(input/output tokens per step/model) to find where tokens actually burn and compress **there**, pointedly.
