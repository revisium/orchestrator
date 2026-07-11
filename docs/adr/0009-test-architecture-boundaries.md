# ADR-0009 - Test architecture boundaries

- **Status:** Accepted
- **Decision date:** 2026-07-10
- **Implementation status:** Stage 2 source migration is implemented. Stage 3 observed-runtime evidence remains
  separately gated and unimplemented.
- **Spec:** [Test architecture v1](../specs/test-architecture-v1.spec.md)
- **Current evidence:** [Test coverage matrix v1](../specs/test-coverage-matrix-v1.json)
- **Relates-to:** [Pipeline test coverage v1](../specs/pipeline-test-coverage-v1.spec.md)

## Context

Revo already distinguishes focused decision tests, static pipeline-policy checks, declarative workflow scenarios,
representative public-surface tests, full-host integration, and runtime lifecycle tests. The source tree and shared
test harness do not preserve those distinctions consistently: concerns share broad support surfaces, public
transports can be confused with in-process adapters, and coverage declarations can be confused with evidence that a
declared behavior executed.

Without explicit boundaries, a test can mix incompatible vocabularies and dependencies, duplicate another layer's
proof, or make ownership unclear. The architecture must preserve the existing CI cost envelope and current
isolation, teardown, and required-check guarantees while those boundaries are introduced.

## Decision

Revo adopts explicit test-layer, context, and evidence-ownership boundaries. Every test has one primary owning layer;
public surfaces and runtime lifecycle use narrow contexts; shared support owns mechanics rather than product
outcomes; and declared ownership remains distinct from observed execution.

The linked specification owns the exact boundary, dependency, enforcement, migration, and future-evidence
requirements. This decision does not choose a persistence model, durable projection, or read contract for observed
runtime evidence. Any such choice requires a separate Stage 3 architecture decision and approval gate.

## Alternatives

- Keep the current broad harness and source layout. Rejected because abstraction levels and ownership would remain
  easy to mix, and support mechanics would continue to spread across suites.
- Reorganize directories without defining ownership and context capabilities. Rejected because paths alone cannot
  prevent tests from importing or asserting at the wrong layer.
- Decide test boundaries and the Stage 3 runtime-evidence design together. Rejected because the boundaries can be
  implemented and evaluated independently, while persistence and read semantics require their own trade-off review.

## Consequences

- Test intent and the proof owned by each layer become explicit.
- Public-surface and runtime tests become easier to review because their contexts expose only owned mechanics.
- Declared coverage cannot be presented as proof of observed execution.
- The migration is cross-cutting: suite moves, context replacement, and deletion of old helpers must remain atomic.
- Narrow contexts and import enforcement add maintenance cost and require coordinated deletion of obsolete helpers.
- A separate Stage 3 architecture decision is required before persistence, projection, reader, or schema work begins.
- Numeric CI regression budgets remain a later human-reviewed calibration decision.
