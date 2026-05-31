# Multi-repo tasks & dependency strategies

> **Status: DRAFT.** Concept settled; built last among the core slices.
> **Depends on:** [architecture-overview.md](./architecture-overview.md) (data-vs-code; strategies are data) ·
> [repo-layer-contract.md](./repo-layer-contract.md) (`createSteps` materializes the plan) ·
> [open-questions.md](./open-questions.md) Q5 (how projects release, for the `release` edge).
> **Realized by:** brief §10.1, built as a slice after roles/inbox (Plan TBD).

"One task = many repos." A task spawns a branch + PR in each affected repo; the **merge is coordinated at the
task level**, not per-PR. The dependency between repos is set **on the edge of the graph** (by the architect
during breakdown, recorded in the ADR).

## Three layers — only the middle is fixed; extend the outer two as data

1. **Primitives** — the stable, small vocabulary (this is code; keep it minimal):
   `merge_pr`, `release_version`, `bump_dependency`, `run_ci`, `wait_approval`, `wait_event`.
2. **Engine** — executes any plan made of primitives. Knows nothing about strategy *names*.
3. **Strategies** — versioned **data**: recipes that lay a dependency graph out into a sequence of primitives.
   Starting edge types: `atomic`, `release`, `after`, `independent`.

A strategy is a function: **(dependency graph) → materialized plan of primitives**. The human sees and approves
that plan at the **plan gate** (see [inbox-and-gates.md](./inbox-and-gates.md)).

## The rule that keeps it stable

- **New strategy = new layout from existing primitives → data only, no engine change.**
- **New mechanism (canary, merge-queue) = new primitive → code.**

So primitives must stay few and stable; everything else evolves as data. The materialized plan becomes ordinary
`steps`/inbox records in Revisium — same state-driven principle as the rest of the system.
