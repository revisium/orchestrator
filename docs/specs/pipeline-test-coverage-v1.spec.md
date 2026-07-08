# Pipeline test coverage v1 spec

- **Status:** Accepted policy; partially implemented.
- **Source files:** `VERIFICATION.md`, `src/e2e/kit/scenario.ts`, `src/e2e/*.e2e.test.ts`,
  `src/control-plane/default-playbook-policy.test.ts`, `src/control-plane/seed-default-playbook.test.ts`,
  `src/poller/pr-readiness.test.ts`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [default-playbook-policy.spec.md](./default-playbook-policy.spec.md),
  [run-profiles-v1.spec.md](./run-profiles-v1.spec.md).

This spec defines how pipeline behavior is tested. It is agent-facing: before adding or changing tests for default
pipelines, run profiles, gates, GitHub readiness, recovery, or consensus routing, agents MUST choose the test layer
from this document instead of adding another broad e2e case by default.

## Scope

The policy applies to product pipeline behavior, especially the bundled `feature-development` and `local-change`
pipelines, their seeded run profiles, and their runtime orchestration contract.

It does not replace focused unit-test ownership for pure functions, nor the e2e performance contract in
`AGENTS.md`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Layer Ownership

Pipeline behavior is covered by four layers. A change MUST state which layer owns the new assertion.

| Layer | Owns | Must not own |
| --- | --- | --- |
| Unit tests | Pure decision internals: readiness, check, review-thread, mergeability, retry/recovery classifiers, validators, materializers. | Full pipeline routing, human-gate progress, external side effects. |
| Static graph/policy tests | Template shape: dangling nodes, gate outcomes, bounded loops, recovery/cleanup paths, forbidden role responsibilities, profile materialization invariants. | Live GitHub/provider freshness, real runner dispatch, end-to-end user-visible outcomes. |
| Declarative DSL e2e tests | Workflow contract: graph edge/outcome execution, gates, terminal status, event path, persisted outputs, and external side-effect calls/no-calls. | Exhaustive classifier branches or implementation details already pinned by unit tests. |
| Full integration e2e tests | A small representative set proving the real host, DBOS/Revisium, runner dispatch, and lifecycle work together. | Cartesian products of profiles, providers, and every classifier permutation. |

Rule of thumb: unit tests cover decision internals; DSL e2e tests cover graph edges and user-visible orchestration
contract.

## Declarative DSL Coverage

New default-pipeline workflow coverage SHOULD use declarative `pipelineScenario` cases, not hand-rolled imperative
e2e code, unless the subject is the harness, host lifecycle, GraphQL subscriptions, or another non-pipeline surface.

A DSL scenario MUST assert the behavior that proves the route:

- expected terminal status or gate;
- expected path or decisive events;
- expected persisted output or gate summary when it explains the route;
- expected external side effect calls, including required no-call assertions for forbidden operations.

A DSL scenario MUST NOT assert private classifier implementation details. If a classifier maps many provider payloads
to the same route verdict, the payload permutations belong in unit tests; the DSL scenario covers the route verdict's
workflow effect.

## Coverage Matrix

The target coverage model is a registry-backed matrix. Each declarative scenario SHOULD carry stable coverage tags.
The final meta-test MUST be cheap enough to run outside the real e2e lane.

Coverage tags use stable ids:

- `node:<nodeId>:outcome:<verdict>` for human-gate and choice outcomes;
- `node:<nodeId>:catch:<errorCode>` for effect failure routes;
- `node:<nodeId>:default` for default branches;
- `profile:<profileId>:signature:<routingSignature>` for representative profile coverage.

The graph-coverage meta-test MUST verify:

- every product template edge/outcome is covered by a DSL tag, a static-policy diagnostic tag, a unit-owned tag, or an
  explicit waiver;
- every DSL tag references a defined edge/outcome or profile signature;
- no scenario uses an undefined tag;
- every waiver has a short reason and an owner surface.

Defensive edges, catch routes, default branches, and counter-bound conjuncts MAY be covered by static-policy diagnostics
instead of a runtime DSL scenario when a runtime scenario would duplicate lower-level proof or create low-value e2e
churn. They MUST NOT disappear silently.

## Profile Coverage

Seeded run profiles MUST NOT be covered by a full e2e Cartesian product. Instead:

- every seeded profile MUST have materialization, routing, runner binding, and static policy validation coverage;
- every distinct routing signature MUST have at least one full DSL e2e scenario;
- consensus profiles MUST include at least one shipped-default scenario for reviewer disagreement or failure that
  routes to rework and then completes;
- adding a new routing signature without full DSL coverage MUST fail the coverage meta-test or add an explicit waiver.

## Human Gates, Recovery, And Skips

Human-gate coverage MUST be per outcome, not per gate. Covering `approve` does not cover `cancel`, `recheck`,
`override_merge`, `address_review_threads`, or `return_to_development`.

Recovery paths are distinct outcomes. Retry, cleanup, human recovery gate, cancel, and timeout/expiry behavior MUST be
tagged separately when they exist in the product graph.

Hard skips in e2e tests are allowed only for tracked open work. A milestone cannot claim zero-gap pipeline coverage
while a hard skip for that milestone remains. If a behavior is deferred, the GitHub issue or milestone umbrella MUST
record the deferral explicitly.

## Bounded Loops

Loop coverage is not satisfied by saying that the graph is not acyclic. Static tests MUST prove an actual bounding
mechanism: a declared counter cap, a monotone rank, or another explicit exit condition. DSL scenarios SHOULD cover at
least one cap-exhaustion path for every user-visible recovery loop family.

## Changelog

- 2026-07-08: Added test-layer ownership, declarative DSL coverage matrix policy, profile coverage rules, and
  hard-skip/milestone guidance after the default-pipeline audit remediation work.
