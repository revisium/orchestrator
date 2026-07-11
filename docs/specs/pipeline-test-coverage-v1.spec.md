# Pipeline test coverage v1 spec

- **Status:** Accepted
- **Version:** v1
- **Implementation status:** The pipeline-specific policy and linked Stage 2 test-boundary migration are implemented;
  Stage 3 observed-runtime evidence remains separately gated and unimplemented.
- **Source files:** `VERIFICATION.md`, `src/e2e/support/pipeline-context.ts`, `src/e2e/pipeline/**/*.e2e.test.ts`,
  `src/control-plane/default-playbook-policy.test.ts`, `src/control-plane/seed-default-playbook.test.ts`,
  `src/testing/policy/pipeline-coverage.ts`,
  `src/testing/policy/pipeline-coverage.test.ts`, `src/testing/policy/hard-skip-issue-ref.test.ts`,
  `src/poller/pr-readiness.test.ts`.
- **Related architecture:** [ADR-0009](../adr/0009-test-architecture-boundaries.md) (Accepted).
- **Current matrix:** [test coverage matrix v1](./test-coverage-matrix-v1.json) (current-state snapshot).
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [default-playbook-policy.spec.md](./default-playbook-policy.spec.md),
  [run-profiles-v1.spec.md](./run-profiles-v1.spec.md),
  [test-architecture-v1.spec.md](./test-architecture-v1.spec.md).

This spec defines how pipeline behavior is tested. It is agent-facing: before adding or changing tests for default
pipelines, run profiles, gates, GitHub readiness, recovery, or consensus routing, agents MUST choose the test layer
from this document instead of adding another broad e2e case by default.

## Scope

The policy applies to product pipeline behavior, especially the bundled `feature-development` and `local-change`
pipelines, their seeded run profiles, and their runtime orchestration contract.

It does not replace focused unit-test ownership for pure functions, nor the e2e performance contract in
`AGENTS.md`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Relationship To The Target Architecture

This spec remains the implemented v1 policy for pipeline-specific ownership and coverage declarations. The Accepted
general test-architecture spec defines the implemented Stage 2 cross-layer boundaries, and the JSON matrix records
current evidence. Neither document claims that Stage 3 runtime evidence is implemented.

The current registry proves declared ownership and typed case attachment against pinned materialized templates and
routing signatures. It rejects duplicate primary owners and incomplete or expired waivers; the committed waiver set
is empty. It does not prove observed runtime traversal. Authoritative observed coverage will come only from runtime
facts through a separately approved Stage 3 persistence, projection, and read design.

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

New default-pipeline workflow coverage SHOULD use an immutable `PipelineCasePlan` through the typed pipeline context,
not hand-rolled imperative E2E code. Host lifecycle and public transports belong to their own typed contexts.

A DSL scenario MUST assert the behavior that proves the route:

- expected terminal status or gate;
- expected path or decisive events;
- expected persisted output or gate summary when it explains the route;
- expected external side effect calls, including required no-call assertions for forbidden operations.

A DSL scenario MUST NOT assert private classifier implementation details. If a classifier maps many provider payloads
to the same route verdict, the payload permutations belong in unit tests; the DSL scenario covers the route verdict's
workflow effect.

## Coverage Matrix

The coverage model is a registry-backed matrix. Each declarative scenario SHOULD carry stable coverage tags. The
meta-test MUST be cheap enough to run outside the real e2e lane, and MUST run in the required CI verification lane.

Coverage tags are stable behavior descriptors:

- `node:<nodeId>:outcome:<verdict>` for human-gate and choice outcomes;
- `node:<nodeId>:catch:<errorCode>` for effect failure routes;
- `node:<nodeId>:default` for default branches;
- `profile:<profileId>:signature:<routingSignature>` for representative profile coverage.

Ownership is assigned to materialized coverage cells, not to tags globally. A cell combines the pinned pipeline id,
profile id, materialized-template hash, routing signature, and one descriptor tag. Reusing a tag in a cloned or changed
template does not reuse ownership: the new materialized cell must receive its own explicit declaration.

The graph-coverage meta-test MUST verify:

- every materialized product-template edge/outcome cell is covered by a DSL scenario, a static-policy diagnostic, a
  unit owner, or an explicit waiver;
- every DSL scenario references cells under its one selected pinned materialized identity;
- static-policy, unit, and waiver declarations resolve to explicit pinned materialized identities and cell ids;
- no declaration uses an undefined or stale cell;
- every primary cell has exactly one owner and no cell is both owned and waived;
- every waiver has stable cells, a short reason, an owner surface, and an expiry stage or condition.

The shipped registry currently carries no waivers. If a future waiver is introduced, it MUST be deliberate,
source-owned, and visible through the registry meta-test; waivers MUST NOT be used to close an audit milestone while the
covered behavior still belongs to that milestone.

Tags remain descriptors for review and diagnostics; they MUST NOT act as a global ownership fallback. Defensive edges,
catch routes, default branches, and counter-bound conjuncts MAY be covered by static-policy diagnostics
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

Hard-skip enforcement itself is a required verification concern: the guard test scans e2e test sources and fails on
untracked hard skips. The shared `e2eSkip` environment gate is not a backlog waiver; required CI runs real e2e with
`REVO_E2E_REAL=1`, where that gate resolves to `false`.

## CI Gate

Required CI MUST run both:

- the cheap verification lane (`pnpm run verify`), including the graph-coverage registry meta-test and hard-skip guard;
- the real e2e lane (`pnpm run test:e2e`) with `REVO_E2E_REAL=1`.

The required-checks job MUST depend on both lanes. A change that removes graph ownership, introduces an untracked hard
skip, or leaves required real e2e failing is not mergeable under this contract.

## Bounded Loops

Loop coverage is not satisfied by saying that the graph is not acyclic. Static tests MUST prove an actual bounding
mechanism: a declared counter cap, a monotone rank, or another explicit exit condition. DSL scenarios SHOULD cover at
least one cap-exhaustion path for every user-visible recovery loop family.

## Changelog

- 2026-07-08: Added test-layer ownership, declarative DSL coverage matrix policy, profile coverage rules, and
  hard-skip/milestone guidance after the default-pipeline audit remediation work.
- 2026-07-09: Marked the policy implemented after the default-pipeline audit remediation close-out: graph coverage is
  registry-backed in required CI, the waiver registry is empty, and hard skips are guarded.
- 2026-07-10: Accepted ADR-0009 and the general test architecture specification, linked the current-state matrix,
  and implemented Stage 2 typed pipeline plans, pinned materialized-cell ownership, waiver expiry validation, and
  source-text-free case attachment; Stage 3 observed-runtime evidence remains separately gated.
