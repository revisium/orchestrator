# Test architecture v1 spec

- **Status:** Accepted
- **Version:** v1
- **Implementation status:** Stage 2 source migration is implemented. Stage 3 remains separately gated and
  unimplemented. Validation remains owned by the existing required verification and real-E2E lanes.
- **Owners:** Revo test architecture, runtime evidence, and CI verification
- **Source files:** `src/**/*.test.ts`, `src/testing/policy/**`, `src/e2e/**`,
  `eslint-local-rules/test-architecture-boundaries.js`, `package.json`, `.github/workflows/ci.yml`
- **Related ADRs:** [ADR-0009](../adr/0009-test-architecture-boundaries.md)
- **Related specs:** [Pipeline test coverage v1](./pipeline-test-coverage-v1.spec.md)
- **Current-state snapshot:** [Test coverage matrix v1](./test-coverage-matrix-v1.json)

## Scope

This specification defines the target test-layer boundaries, support contexts, coverage ownership model, future
runtime-evidence requirements, semantic snapshot discipline, enforcement split, migration order, and performance
constraints for Revo tests.

It governs:

- focused unit tests;
- static policy and structural tests;
- declarative pipeline DSL tests;
- representative full-host integration tests;
- representative MCP, GraphQL, and CLI surface tests;
- runtime lifecycle, recovery, concurrency, and teardown tests;
- shared test support;
- declared and observed pipeline-coverage evidence;
- the documentation-owned current-state matrix.

It does not define the persistence schema, transport API, or complete event vocabulary for semantic runtime evidence.
Stage 3 will define that contract in a separate semantic-runtime-trace specification. It also does not authorize live
provider credentials, external mutations, or a provider-smoke target.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY, REQUIRED, and OPTIONAL are to be interpreted as described in
RFC 2119 and BCP 14 when, and only when, they appear in all capitals.

## Current Contract

The current pipeline-specific policy separates unit, static policy, declarative DSL, and representative full
integration responsibilities. The default-pipeline coverage registry assigns stable tags to DSL, static-policy, unit,
or waiver owners, and its required meta-test rejects undefined and unowned declarations. The shipped registry has no
waivers at the source revision recorded in the current-state matrix.

The current registry proves declared ownership. Typed case identity is validated against cells derived from pinned
materialized templates and routing signatures. It does not prove observed runtime traversal, and scenario coverage
metadata is not compared with persisted execution facts.

Registry ownership is keyed by full `PipelineCoverageCellId`. Tags are behavior descriptors only: DSL declarations
resolve within their selected pinned materialized identity, while static-policy, unit, and waiver declarations resolve
to explicitly selected pinned identities and cells. A cloned or changed materialized template cannot inherit ownership
merely by reusing existing tags.

The current `src/e2e/` tree separates pipeline, integration, public-surface, runtime, and support ownership. Narrow
typed contexts keep host construction, DBOS, storage, provider mechanics, polling, and subprocess cleanup private.
The former `src/e2e/kit/` barrel and source-text attachment mechanism no longer exist.

Real end-to-end tests use DBOS, Revisium, and embedded PostgreSQL. Agents and external provider behavior are normally
controlled. Representative MCP stdio, GraphQL HTTP/WebSocket, CLI subprocess, and isolated host lifecycle cases now
exercise their actual boundaries. There is no persisted semantic runtime evidence contract and there are no semantic
test snapshots.

The JSON matrix linked above is a versioned current-state snapshot. It is not the final executable coverage registry.

## Implemented Stage 2 And Future Stage 3 Contract

The requirements in this section remain normative. Stage 2 boundary and declaration requirements are implemented;
Stage 3 observed-evidence and snapshot requirements remain future, separately approved work.

### Terms

- A **contract cell** is one independently ownable behavior obligation with a stable semantic identity.
- **Catalog cells** are the complete distinct set of contract cells derived from one pinned catalog revision.
- **Owned cells** are catalog cells assigned to a primary non-waiver test owner.
- **Waived cells** are catalog cells assigned to a complete waiver instead of a test owner.
- A **complete waiver** identifies its catalog cells, reason, accountable owner surface, and expiry stage or condition.
- A **coverage declaration** assigns a catalog cell to one primary test owner or to one complete waiver.
- **Observed evidence** is an authoritative runtime fact produced by the system under test during the same run. Its
  persistence, projection, and read contract require the separate Stage 3 architecture gate.
- A **semantic snapshot** is a deterministic projection of observed evidence from one run.
- A **surface context** is the narrow test API for one public transport.
- **Exhaustive** coverage enumerates every member of a bounded, declared contract partition.
- **Representative** coverage selects a small set of end-to-end cases while lower layers own the remaining partitions.

### Layer ownership

Every test MUST have one primary owning layer. A behavior MAY have corroborating evidence in another layer, but each
assertion MUST remain within the vocabulary and mechanics of its primary layer.

#### Unit

Unit tests MUST own pure decision internals, classifiers, reducers, validators, materializers, serializers, and focused
adapter behavior. Their bounded input partitions SHOULD be exhaustive. Unit tests MUST NOT start the host, use DBOS,
poll persisted state, invoke public transports, or claim workflow traversal.

#### Static policy

Static-policy tests MUST own template shape, policy diagnostics, bounded-loop structure, catalog/profile validity,
coverage declarations, and structural drift. Static-policy tests MUST NOT create runs, resolve gates, use timers, or
perform network or process actions.

#### Pipeline DSL

Pipeline DSL tests MUST own user-visible workflow routes, gate outcomes, terminal outcomes, persisted route reasons,
and required or forbidden side effects. DSL execution cases MUST declare the product graph cells they intend to
execute. The static-policy layer MUST account exhaustively for catalog ownership and waivers. Cells assigned to unit,
static-policy, or waiver ownership MUST remain explicit rather than being counted as DSL execution. Classifier payload
permutations MUST NOT be duplicated here when a focused layer already proves the mapping.

#### Representative full integration

Full-integration tests MUST prove that the real host, DBOS, Revisium, embedded PostgreSQL, runner dispatch, and run
lifecycle work together. Their scenario set MUST remain representative. They MUST NOT form a Cartesian product of
profiles, providers, route inputs, or classifier cases.

#### Representative surface E2E

Surface tests MUST exercise the actual public boundary named by the suite. MCP surface E2E MUST use the stdio MCP
bridge. GraphQL surface E2E MUST use HTTP or WebSocket documents. CLI surface E2E MUST use a child process and assert
argv-visible behavior through exit status, stdout, stderr, and lifecycle effects.

Calling an MCP facade, GraphQL resolver, or CLI command function directly MUST be classified as focused adapter
evidence rather than surface E2E. Public-surface suites MUST remain representative; schema, validation, and pure
response partitions belong in focused tests.

#### Runtime lifecycle, recovery, and concurrency

Runtime tests MUST own host start/stop/restart, crash and recovery, replay/idempotency, queue behavior, concurrent run
isolation, parked gates, and teardown. They MUST use representative fault and contention cases. They MUST NOT absorb
classifier Cartesian products or public-transport matrices.

#### Support

Support code MAY own fixture lifecycle, controlled fakes, polling primitives, persisted-fact readers, timing capture,
and deterministic data builders. Support code MUST NOT choose product outcomes, auto-resolve an unspecified gate,
substitute terminal state for missing evidence, or contain product-behavior assertions.

### Directory intent and dependency direction

Stage 2 MUST establish this directory intent:

```text
src/<production-area>/*.test.ts          focused unit and adapter tests
src/testing/policy/                      static policy, declarations, and drift checks
src/e2e/support/                         host fixtures, controlled fakes, readers, and timing
src/e2e/pipeline/                        declarative pipeline DSL suites
src/e2e/integration/                     representative full-host integration suites
src/e2e/surfaces/mcp/                    stdio MCP suites
src/e2e/surfaces/graphql/                HTTP and WebSocket GraphQL suites
src/e2e/surfaces/cli/                    subprocess CLI suites
src/e2e/runtime/lifecycle/               host lifecycle suites
src/e2e/runtime/recovery/                crash, replay, and recovery suites
src/e2e/runtime/concurrency/             contention, isolation, and teardown suites
```

The target dependency direction MUST be one way:

```text
unit -> production module
static-policy -> pure policy/compiler + catalog + declarations
pipeline | integration | surfaces | runtime -> e2e/support -> production
```

Pipeline, integration, surface, and runtime suites MUST NOT import one another. Support MUST NOT import a test suite.
Focused tests and static-policy tests MUST NOT import E2E support. Test suites MUST use explicit support imports; a
wildcard barrel that exposes every E2E mechanic MUST NOT be part of the target architecture.

### Vocabulary and forbidden mechanics

| Layer | Allowed vocabulary | Forbidden mechanics |
| --- | --- | --- |
| Unit | domain input, result, verdict, diagnostic, serialization | host, DBOS, polling, transport, persisted trace |
| Static policy | template, selector, profile, diagnostic, contract cell, declaration | run creation, gate resolution, timers, network, subprocess |
| Pipeline DSL | given, start, named gate, route, terminal, side effect, semantic evidence | raw service API, DBOS handle, raw event polling, global run map, provider argv |
| Full integration | run, task, real host, controlled runner, settled lifecycle | public-transport claims, classifier permutations, provider Cartesian product |
| MCP surface | tool call, MCP result, `isError`, semantic response | facade, service, handler registration, direct method call |
| GraphQL surface | document, variables, data, errors, subscription | resolver or service invocation, database query |
| CLI surface | argv, exit status, stdout, stderr, process lifecycle | command-function import, Nest service access |
| Runtime | host, crash, restart, recover, replay, parallel run, settled evidence | business classifier matrix, public-surface substitution |
| Support | fixture, controlled fake, wait, persisted fact, timing | fallback outcome, product assertion, suite registration |

Test modules MUST NOT route controlled behavior through mutable test-global maps keyed by run id. A case plan MUST be
complete before the run starts. A fixture MAY retain private lifecycle state, but a suite MUST NOT mutate or inspect
that state as a product API.

### Context boundaries

Stage 2 MUST provide separate pipeline, integration, MCP, GraphQL, CLI, and runtime contexts. Each context MUST expose
only the actions and observations owned by its layer.

- The pipeline context MUST accept an immutable case plan before start. It MUST expose named gate resolution, settled
  completion, route/terminal assertions, and required or forbidden side-effect assertions.
- The integration context MUST expose a minimal run lifecycle over the real host. It MUST keep controlled external
  dependencies behind the fixture boundary.
- The MCP context MUST expose stdio tool discovery and tool calls. It MUST preserve the distinction between transport
  completion and `isError` application failure.
- The GraphQL context MUST expose HTTP queries/mutations and WebSocket subscriptions. It MUST return protocol-visible
  data and errors rather than resolver internals.
- The CLI context MUST expose subprocess invocation and process lifecycle. It MUST return exit status, stdout, and
  stderr.
- The runtime context MUST expose host start, stop, restart, crash, recovery, and bounded parallel execution. It MAY
  expose privileged runtime controls that are forbidden to other contexts.
- The host fixture MUST own service construction and cleanup. It MUST NOT leak a Nest application context, DBOS handle,
  raw persistence services, or raw event APIs into pipeline or surface tests.

Stage 3 MAY add a semantic-evidence reader to the pipeline, integration, and runtime contexts. That reader MUST expose
only the persisted semantic projection defined by the Stage 3 contract.

## A1 Authoring Contract (Target Migration)

This section defines the Stage 2 authoring contract that A2 through A6 will
implement. It does not change the current Stage 2 runtime behavior. It does
not define Stage 3 persistence, projection, snapshots, timing, or budget
behavior.

### Authoring vocabulary

Each test MUST use the vocabulary of its primary owning layer. Each test MUST
keep its decisive proof at one semantic altitude. A context MAY hide mechanics
that belong to its layer. A context MUST NOT hide the decisive behavior named
by the test.

The four context capabilities are:

| Capability | Contract | Forbidden leakage |
| --- | --- | --- |
| Action | Performs one named operation and returns typed protocol or domain output. | An action MUST NOT assert a later terminal state, route, reason, persisted output, or side effect. |
| Bounded wait | Polls for one named observation within the owning wait bound. | A wait MUST NOT substitute terminal state for missing route, reason, persisted-output, or side-effect evidence. |
| Observation | Returns typed state or facts owned by the layer. | An observation MUST NOT decide whether the returned state is correct. |
| Expectation | Asserts one named obligation against an explicit expected value. | An expectation MUST NOT hide unrelated obligations behind a vague or compound helper. |

Context-internal assertions MAY enforce malformed protocol data, impossible
fixture handles, startup failure, and cleanup failure. Those assertions are
mechanical invariants and MUST NOT replace the behavior assertion owned by the
test.

### Per-layer authoring requirements

The following requirements define exemplar ownership. A2 MUST implement one
real executable exemplar for each layer in its ordinary required lane. A2 MUST
NOT add a toy suite or a duplicate example suite. Documentation MUST link to
the owning executable exemplar after it exists.

| Layer | Primary abstraction level | Exemplar requirement |
| --- | --- | --- |
| Unit | Pure input, call, result, and focused decision assertion. | The test MUST expose the decision input partition and expected result without an E2E context. |
| Static policy | Diagnostics, structural cells, and ownership algebra. | The test MUST expose the checked policy facts and diagnostics without creating a run or using a timer. |
| Pipeline DSL | Declared coverage, pre-start inputs, named actions, and user-visible workflow obligations. | The test MUST expose coverage identity, the route or reason, the terminal outcome, and each required or forbidden side effect. |
| Full integration | Real-host lifecycle and representative external-effect integration. | The test MUST expose start, settled lifecycle, and the representative external effect or its absence. |
| MCP surface | Stdio tool call and protocol/application result. | The test MUST expose `isError` and the semantic response or error fields. |
| GraphQL surface | Named document, variables, protocol response, and subscription result. | The test MUST expose status, data or errors, and path when the contract provides one. |
| CLI surface | Visible argv, subprocess result, and process lifecycle. | The test MUST expose exit status, stdout, stderr, and lifecycle effects owned by the scenario. |
| Runtime | Lifecycle action, recovery or concurrency state, and causal evidence. | The test MUST expose the action, settled state, reason, and replay or isolation proof required by the scenario. |

The unit and static-policy exemplars MUST remain focused on their respective
layers. The pipeline, integration, surface, and runtime exemplars MUST use
their owning typed contexts. A lower layer MUST NOT duplicate a higher-layer
workflow claim. A higher layer MUST NOT duplicate a lower-layer classifier
partition.

### Enforcement split and review rubric

TypeScript MUST enforce immutable plans, closed identifiers, branded targets,
and typed context results. ESLint MUST enforce dependency direction, context
imports, forbidden raw mechanics, and the absence of broad E2E barrels. Cheap
meta-tests MUST enforce discovery, layer ownership, attachment identity,
ownership algebra, waiver metadata, exemplar paths, and obsolete export
absence. Runtime tests MUST enforce the approved runtime behavior in the
existing real-E2E lane. Documentation MUST own rationale and normative rules.

Review MUST decide semantic altitude, decisive proof sufficiency, abstraction
minimality, and representative-versus-exhaustive coverage. Review MUST NOT
delegate those judgments to source-text formatting, an AST readability rule,
or a universal fluent DSL.

### Migration and deletion boundary

A2 MUST establish the typed descriptors and real per-layer exemplars. A2
MUST refresh the current matrix only in its approved matrix slice.

A3 MUST directly replace pipeline DSL authoring with the contract in this
section. A4 MUST directly replace integration and runtime authoring. A5 MUST
directly replace MCP, GraphQL, and CLI surface authoring.

During A3 through A5, temporary coexistence MAY identify suites that have not
yet migrated. Temporary coexistence MUST be bounded to those named suites. It
MUST NOT add aliases, overloads, facades, dual-write paths, or fallback plan
shapes.

A6 MUST delete the remaining old helpers, old declaration paths, and temporary
coexistence markers. A6 MUST activate final enforcement after deletion. A6
MUST NOT preserve compatibility aliases for migrated APIs.

Migration MUST preserve coverage-cell identity, layer ownership, assertion
strength, required verification lanes, CI and local concurrency, timeout
values, and the existing E2E performance envelope. Migration MUST NOT reduce
scenarios or assertions, add waivers, or change product behavior.

### Explicit non-goals

This A1 contract MUST NOT introduce a universal fluent DSL. It MUST NOT
introduce a source-text readability checker. It MUST NOT introduce a
compatibility alias. It MUST NOT refresh the coverage matrix. It MUST NOT
add a Stage 2 ADR or specification. It MUST NOT define Stage 3 runtime
evidence, persistence, projection, snapshots, timing, or budget behavior. It
MUST NOT change product code, test code, coverage partitions, concurrency,
timeouts, waivers, or CI policy.

### Target examples

The examples in this section are informative and show assertion altitude; exact implemented private identifiers may
differ.

Unit:

```ts
const result = classifyReadiness(pendingChecks());
assert.deepEqual(result, { verdict: 'recheck', reason: 'checks_pending' });
```

Static policy:

```ts
const diagnostics = validateDefaultPolicy(template);
assert.deepEqual(diagnostics, []);
assert.deepEqual(contractCells(template), expectedCells);
```

Pipeline DSL:

```ts
const run = await pipeline.start(given.feature().checksNeverSettle());
await run.gate('plan').resolve('approved');
await run.gate('recovery').resolve('cancel');
await run.expect.route('prRouter', 'default', 'recoveryGate');
await run.expect.terminal('cancelled');
await run.expect.noSideEffect('merge_pull_request');
```

Representative full integration:

```ts
const run = await integration.createRun({ pipeline: 'local-change' });
await run.start();
await run.expect.settled('succeeded');
assert.equal(run.runnerCalls.length, 1);
```

MCP surface:

```ts
const result = await mcp.callTool('create_run', input);
assert.equal(result.isError, false);
assert.equal(typeof result.content.runId, 'string');
```

GraphQL surface:

```ts
const result = await graphql.execute(createRunDocument, variables);
assert.equal(result.errors, undefined);
assert.equal(result.data.createRun.status, 'created');
```

CLI surface:

```ts
const started = await cli.run(['start']);
assert.equal(started.exitCode, 0);
const status = await cli.run(['status']);
assert.match(status.stdout, /running/);
```

Runtime recovery/concurrency:

```ts
const run = await runtime.crashAt('merge-gate');
await runtime.restart();
await run.expect.recoveredOnce();
await run.expect.terminal('succeeded');
```

Support fixture lifecycle and isolation:

```ts
const first = await support.hostFixture();
const second = await support.hostFixture();
assert.notEqual(first.dataDirectory, second.dataDirectory);
await Promise.all([first.close(), second.close()]);
assert.deepEqual([first.closed, second.closed], [true, true]);
```

### Coverage declarations and ownership

The executable declaration model MUST use stable contract-cell identities. A contract cell MUST be derived from the
pinned materialized template and routing signature rather than from a test filename or source-text match.

The static-policy layer MUST own catalog-cell generation, declaration validation, primary-owner validation, and waiver
validation. DSL scenarios MUST remain declared execution cases. After the Stage 3 authority and reader contract is
implemented, a DSL scenario that makes an observed-coverage claim MUST consume that evidence. DSL scenarios MUST NOT
own the catalog accounting mechanism.

For each catalog revision, the cheap verification lane MUST enforce this catalog ownership algebra:

```text
catalog cells = owned cells union waived cells
owned cells intersection waived cells = empty
owner count(cell) = 1 for every cell in owned cells
complete waiver count(cell) = 1 for every cell in waived cells
```

Unknown declarations MUST fail the cheap verification lane. Stale declarations MUST fail the cheap verification lane.
Corroborating tests MAY exist, but they MUST NOT be registered as additional primary owners. A complete waiver MUST
satisfy the metadata contract in the Waivers section.

Per-scenario observation is separate from catalog ownership. A runtime scenario MAY declare required observed cells
and forbidden observed cells. The same cell MUST NOT appear in both scenario sets. Once the Stage 3 authority and
reader contract is approved and implemented, comparison MUST use these subset rules:

```text
required observed cells subset-of observed runtime cells
forbidden observed cells intersection observed runtime cells = empty
```

An exact semantic route assertion MUST use equality after normalization. Extra observed cells MUST be reported as
diagnostics and MUST NOT silently satisfy an unrelated declaration. Unit-owned and static-policy-owned cells MUST NOT
be promoted to observed runtime coverage unless a DSL or runtime owner declares them independently.

Each explicit selector, default branch, catch route, timeout route, and human-gate outcome MUST retain its own stable
contract-cell identity. A grouped verdict set MAY share one route-equivalence cell only when every member has the same
target and orchestration semantics. In that case, one runtime witness MAY prove the route cell, while focused tests
MUST own normalization of the other input members. Human-gate outcomes MUST NOT be grouped this way.

An absence claim, such as a forbidden route or side effect, MUST be evaluated only against a complete authoritative
evidence set. An incomplete evidence set MUST NOT prove absence.

Stage 2 replaces source-text attachment with typed suite or case identity and preserves the v1 declared-ownership
proof. Stage 2 does not claim that runtime traversal is observed.

### Authoritative observed evidence

This section constrains future observed-coverage claims. It does not approve a persistence model, durable projection,
or read contract. A separate Stage 3 architecture gate MUST select those mechanisms before implementation.

Stage 3 MUST make authoritative runtime facts the sole authority for observed pipeline coverage. Scenario actions,
fixture configuration, expected gate choices, mock call plans, source filenames, and coverage declarations MUST NOT
produce observed coverage.

The runtime evidence MUST identify the pinned pipeline/profile meaning and the completed run. It MUST represent node
visits, selected routes or outcomes, effect attempts/results, retries, repeated nodes, forks, joins, side effects, and
terminal completion when those semantics occur. It MUST provide a completeness signal before comparison.

The evidence producer MUST be replay-safe. Repeating the same semantic fact MUST be idempotent. Conflicting facts for
the same semantic occurrence MUST fail visibly. Evidence required for coverage MUST NOT be best-effort telemetry.

Any authoritative projection approved at Stage 3 MUST exclude secrets, prompt text, raw provider payloads, raw
outputs, and unstable transport identifiers. Generic runtime events MAY remain operator evidence, but they MUST NOT
become authoritative observed coverage merely by being read or normalized after the run.

The same E2E invocation that executes a scenario MUST read and compare its authoritative evidence. Trace or snapshot
work MUST NOT trigger a second E2E pass.

The exact durable recording mechanism, persistence tables, projection, fact schema, completeness marker, digest,
reader API, and compatibility rules are out of scope here. The separate Stage 3 architecture decision and linked
semantic-runtime-trace specification MUST define them before implementation.

### Retries, repeated nodes, joins, and terminals

A retry declaration MUST distinguish the logical node visit from its physical attempts. Observed evidence MUST
distinguish retry scheduling, successful retry, and retry exhaustion when each behavior is claimed.

A repeated-node declaration MUST identify visit semantics independently of display strings. Observed evidence MUST
preserve the visit count or causal sequence needed to distinguish repeated execution.

A fork/join declaration MUST identify declared branch identity and join semantics. Observed evidence MUST record the
arrivals that affect the join, the selected or reduced result, and any winning branch required by the contract.

A terminal declaration MUST include the terminal semantic identity and status. Terminal status alone MUST NOT prove
the route, retry, join, or side-effect reason that led to it.

### Semantic snapshots

A semantic snapshot MUST be a normalized projection of authoritative observed evidence from the same run. It MUST NOT
be generated from scenario actions, expected values, raw event dumps, or a separate execution.

The projection MUST include only stable semantic identity needed to review behavior. It MUST exclude run ids, task ids,
event ids, inbox ids, attempt ids, timestamps, durations, costs, logs, raw errors, raw outputs, secrets, and provider
payloads. Object keys and branch projections MUST have deterministic order.

Every snapshot case MUST also assert its terminal outcome, route reason, and required or forbidden side effects
explicitly. A snapshot MUST NOT replace an explicit assertion. Snapshot updates MUST be reviewed as behavior changes;
bulk acceptance MUST NOT be used to hide a mismatch.

### Waivers

A waiver MUST identify stable contract cells, a reason, an accountable owner surface, and the stage or condition that
ends the waiver. A waiver MUST be visible to the cheap registry meta-test. An incomplete, unknown, expired, or stale
waiver MUST fail verification.

A waiver MUST NOT be added to satisfy a timing budget. A waiver MUST NOT be used to claim completion of the milestone
that still owns the waived behavior. A hard skip MUST NOT substitute for a waiver.

### Current-state matrix ownership

`docs/specs/test-coverage-matrix-v1.json` MUST remain valid JSON. It MUST record its schema version, snapshot status,
source revision, observation date, performance baseline, layer definitions, and contract-family rows.

Every evidence path in the matrix MUST be repository-relative. Every row MUST record an owner, exhaustive or
representative policy, current status, evidence paths, gaps, relative CI cost, and target stage.

The matrix MUST describe current source evidence and MUST distinguish partial evidence from evidence that is absent.
It MUST NOT claim that a future context, runtime trace, snapshot, or observed comparison is implemented. It MUST NOT be
used as the final executable registry.

The matrix owner MUST update the snapshot when a listed family changes status, evidence path, policy, ownership, or
target stage. A source revision change alone does not require a matrix rewrite when the recorded evidence remains
unchanged; the next substantive matrix update MUST refresh the revision and observation date.

### Enforcement responsibilities

TypeScript MUST define narrow context capabilities, immutable case declarations, contract-cell identities, and the
future observed-evidence model. Types MUST prevent a surface context from exposing unrelated support mechanics.

ESLint MUST enforce target directory imports, prohibit lateral suite imports, prohibit the broad E2E barrel, and
prevent raw service/DBOS/event access in pipeline and surface suites. ESLint SHOULD reject test-global run-routing
maps in migrated suites when a reliable syntax rule exists.

Cheap meta-tests MUST validate declaration identity, catalog-to-cell generation, complete ownership, waiver metadata,
suite attachment without source-text regex, matrix JSON shape, and stale or unknown cells. They MUST run in the
required verification lane.

Runtime tests MUST validate the approved authoritative-evidence contract's completeness, replay/idempotency, retry,
repeated-node, fork/join, terminal, and redaction behavior. Runtime comparison MUST run in the existing real-E2E lane.

Documentation MUST own architectural rationale, normative layer rules, and the current snapshot. Documentation MUST
NOT duplicate executable declarations.

### Performance and CI

The target MUST preserve required verification and real-E2E lanes. Runtime evidence, semantic snapshots, and observed
coverage MUST be collected during the existing E2E run. They MUST NOT cause a second E2E invocation.

Until measured evidence supports a separately approved change, CI MUST retain file concurrency two. Local E2E MUST
retain its current default file concurrency four. The per-file DBOS database, suite home reset, preinstalled playbook,
settled polling, filtered cross-file reads, teardown workflow cancellation, forced process exit, 100 ms test shutdown
drain cap, and 30-second stuck detector MUST remain intact.

The fresh Stage 1 baseline is a sample of the ten latest successful `master` CI runs:

| Measure | Median | Maximum |
| --- | ---: | ---: |
| E2E job | 132 seconds | 189 seconds |
| Combined setup-plus-test action step | 115 seconds | 164 seconds |

The values in the Maximum column are maxima, not p95 measurements. The local E2E wall-clock target remains 70 to 90
seconds. The combined action step cannot currently separate setup from test execution.

Stage 3 MUST emit same-run timing evidence that distinguishes setup time, action-step wall time, per-scenario marginal
time, and semantic-trace projection time. It MUST also record the scenario count and declared/observed cell counts
needed to compare like with like.

This specification does not define a hard percentage threshold. Regression budgets MUST be calibrated later from a
stable window of same-run timing artifacts and MUST be approved before enforcement.

Stage 2 MUST evaluate non-regression through human review of current CI durations against the recorded E2E job and
combined action-step baseline above. Stage 2 MUST use current GitHub Actions durations because same-run timing
artifacts do not yet exist.

Stage 3 MUST introduce same-run timing artifacts and MUST evaluate non-regression with comparable artifacts before
merge. Artifact-based calibrated enforcement MUST belong only to Stage 3 or later and MUST NOT activate until its
budget is separately approved. Until that approval, artifact comparisons MUST remain human reviewed. Faster execution
SHOULD be pursued only when verifiability remains equivalent or stronger.

An implementation MUST NOT weaken checks, add waivers, raise timeouts, reduce scenarios, or reduce required CI
parallelism to satisfy a timing budget. A correctness mismatch MUST remain a correctness failure even when its timing
budget passes.

### Migration and deletion

Migration MUST occur in this order:

1. Stage 1 recorded ADR-0009 and this specification as Accepted, retained the current-state matrix, and completed the
   human architecture approval gate.
2. Stage 2 introduced surface-specific contexts, directory intent, typed declared-coverage attachment, recursive
   discovery, and import enforcement. It preserves declared-only semantics and makes no observed-runtime claim.
3. After its separate architecture gate, Stage 3 defines and implements the approved authoritative-evidence
   persistence, projection, and read contract; compares declared versus observed coverage; adds semantic snapshots;
   and emits same-run timing artifacts.
4. The Stage 2 migration deleted the old wildcard E2E barrel, source-regex attachment, mutable run-ID routing maps,
   and terminal-for-missing-evidence fallback. Future replacements MUST retain that direct-replacement policy.

Temporary coexistence MAY distinguish migrated from unmigrated suites. It MUST NOT introduce a long-lived compatibility
alias, facade, dual-write path, or generic-event-to-semantic-trace converter. Historical runs MUST NOT be backfilled by
inferring authoritative trace facts from generic events.

Human architecture approval of ADR-0009 and the Stage 2 source migration are complete. The Stage 3 persistence,
projection, and read design requires a separate architecture decision and review against this contract before runtime
or schema changes begin.

## Validation

Stage 2 validation consists of TypeScript, project-local ESLint boundaries, recursive discovery checks, typed
coverage/matrix policy tests, the required `pnpm verify` lane, and the existing real-E2E lane. A source migration or
cheap-lane result must not be interpreted as a passing result for an unrun real-E2E suite.

## Compatibility

This is a clean-replacement architecture. Existing test behavior remains supported during migration, but obsolete test
helpers and declaration attachment mechanisms have no long-term compatibility guarantee.

The implemented [Pipeline test coverage v1](./pipeline-test-coverage-v1.spec.md) remains authoritative for current
pipeline-specific policy until a later accepted specification explicitly supersedes it. This Accepted specification
does not change product persistence or runtime APIs. Stage 2 changes test source layout and discovery while preserving
the existing required CI lanes.

## Changelog

- 2026-07-10: Added the Stage 1 target test architecture, durable runtime-evidence requirements, current matrix
  ownership, migration order, and measured CI baseline for human architecture review.
- 2026-07-10: Accepted ADR-0009 and this specification after Stage 1 human approval; Stage 2 is eligible but remains
  unstarted, and Stage 3 remains separately gated.
- 2026-07-10: Implemented Stage 2 directory/context boundaries, actual public transports, isolated host lifecycle,
  recursive E2E discovery, typed declared coverage, matrix drift checks, and ESLint enforcement; Stage 3 remains gated.
