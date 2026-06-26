# ADR-0002 - Data-driven pipeline state machine

- **Status:** Accepted
- **Decision date:** 2026-06-19
- **Amends:** [ADR-0001](./0001-execution-engine-and-host.md)
- **Specs:** [pipeline state machine](../specs/pipeline-state-machine-v1.spec.md),
  [run dataflow](../specs/run-dataflow-v1.spec.md),
  [human gates](../specs/human-gates-v1.spec.md)

## Context

The initial DBOS implementation proved durable execution with a fixed task flow. That was useful for bootstrap,
but it left method meaning in code: adding a role, moving a gate, or changing rework routing required engine
changes.

The product direction is that method is data. Roles, playbooks, pipeline shape, gates, and routing policy must be
reviewable and versioned as data while the engine remains generic.

## Decision

Represent each pipeline as a versioned graph template and execute it with a generic state-machine engine.

The engine is split in two:

- `src/pipeline-core/` is pure and deterministic. It validates templates, interprets the graph, updates the
  cursor, and emits one decision at a time.
- `src/pipeline/data-driven-task.workflow.ts` is the DBOS adapter. It loads the pinned template, persists
  progress, executes decisions through runners/scripts/inbox waits, records outputs, and feeds recorded results
  back into the core.

The template grammar is closed and typed: agent, script, humanGate, choice, parallel, join, wait, and terminal
nodes; explicit transitions; tagged guard conditions; domain verdicts; scoped counters; and install-time
validation.

## Examples

- A plan gate is a `humanGate` node in the template, not a hardcoded runtime branch.
- A reviewer `blocker` verdict loops to developer rework only because a template branch says so.
- `local-change` and `feature-development` use the same engine; they differ by pipeline data.

## Alternatives

- **Keep fixed workflows in code:** rejected because role and gate changes would keep requiring engine edits.
- **Use expression strings for guards:** rejected because embedded DSLs are hard to review and validate.
- **Let agents decide loop bounds:** rejected because rework caps must be deterministic engine state.
- **Inline all step output into the routing state:** rejected because content and routing have different size,
  replay, and storage requirements.

## Consequences

- The graph grammar and validator are product contracts; update the specs with any semantic change.
- `pipeline-core` must remain free of I/O, DBOS, runners, clocks, randomness, and hardcoded role ids.
- Runs pin a template revision at start. HEAD edits affect new runs only.
- Revisium stores template meaning and runtime projections; DBOS stores authoritative progress.
- Dataflow between steps is explicit with `produces` and `consumes`; routing remains a small recorded signal.
