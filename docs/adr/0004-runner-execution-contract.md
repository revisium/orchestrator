# ADR-0004 - Runner execution contract

- **Status:** Draft
- **Decision date:** 2026-06-29
- **Specs:** [runner manifest v1](../specs/runner-manifest-v1.spec.md),
  [runner result envelope v1](../specs/runner-result-envelope-v1.spec.md),
  [runner capabilities v1](../specs/runner-capabilities-v1.spec.md)
- **Refines:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md) (data-driven pipeline state machine)

## Context

ADR-0002 made the engine generic: `src/pipeline-core/` knows no role ids or pipeline shapes, and runner choice is
meant to hide behind `role.runner`. The [runner contract](../runner-contract.md) restates this: runner-specific
CLI flags and protocol details stay inside runner implementations; the engine only resolves a capability handle to
a runner and records its result.

That boundary does not hold today. Runner conventions leak into the generic engine as hardcoded branches on
literal runner ids:

- `dispatchRunnerId` branches on `'stub-agent'`, `'claude-code'`, `'codex'`, `'script'`, and a `'revo-'` prefix
  (`src/pipeline/route-contract.ts:110-114`).
- `runnerNeedsLivePreflight` enumerates `'claude-code'`, `'codex'`, `'revo-integrator'`, `'revo-merger'`
  (`src/pipeline/route-contract.ts:116-118`).
- `runnerUsesRealIntegrator` enumerates `'revo-integrator'`, `'revo-merger'`
  (`src/pipeline/route-contract.ts:120-122`).
- `runnerProducesWorktreeChanges` enumerates `'claude-code'`, `'codex'`
  (`src/pipeline/data-driven-task.workflow.ts:358-360`).
- The `RunAgent` factory `switch (args.role.runner)` enumerates `'claude-code'`, `'codex'`, `'script'`,
  `'stub-agent'` (`src/worker/runner-dispatch.ts:8-20`).
- The default runner id falls back to the literal `'claude-code'` (`src/control-plane/definitions.ts:112`).

Provider coupling also leaks into one adapter: the Codex runner rejects any non-OpenAI-compatible provider via a
hard throw (`requireCompatibleProfile`, `src/worker/codex-runner.ts:179-186`).

Consequence: adding a runner today means editing the engine in roughly five synchronized decision sites across two
files — even when the new runner is the *same protocol shape* as an existing one. This blocks Codex hardening
(#184), an OpenCode runner (#187), and execution profiles (#168).

The variation between runners is not uniform. Some of it is irreducibly code (each vendor frames its output as a
different event tree), and some is pure data (flag names, schema delivery mechanism, the rights→sandbox table). The
engine treats all of it as code, in the wrong layer.

## Decision

Adopt a three-layer runner model that splits runner knowledge by what genuinely varies, so the engine grows by
number of *code strategies* (a small set of `stdoutParser` + `permissionStyle` ids, ~4-5 of each ever), not by
number of runners.

- **Layer 1 - code strategies (CODE).** A closed registry of code strategies, referenced by id, on two orthogonal
  axes. `stdoutParser` is a pure function from the runner's raw output stream to a normalized result (irreducibly
  code — each vendor frames a bespoke event tree). `permissionStyle` maps portable `role.rights` +
  `role.allowedTools` to the runner's native permission expression (a tiny interpreter over a data table). A
  manifest references the two ids **independently** — there is no bundled single `family` id. Code is added only
  when a new parser or style appears, never when a new runner reuses an existing pair.
- **Layer 2 - runner manifest (DATA).** A declarative record binding a concrete runner to a `stdoutParser` id, a
  `permissionStyle` id, and declarable fields (`binary`, `argTemplate`, `schemaDelivery`, `promptDelivery`,
  `constraints`, `capabilities`, `timeouts`). Adding a runner that reuses an existing `(stdoutParser,
  permissionStyle)` pair is a pure manifest change: zero engine code.
- **Layer 3 - profile / registry (SELECTION).** Which runner a role resolves to, per profile, and the registry
  that holds manifests, are a separate decision (#169 / #170 / #186, a future selection ADR). This ADR defines the
  contract a selected runner must satisfy; it does not define selection.

The four runner-id branch functions and the provider throw become declarative `capabilities` and `constraints`
manifest data. `structuredOutput` becomes a three-tier capability (`native-schema` | `tool-call` | `prompt-only`),
not a boolean; `prompt-only` is always the floor that leans on the engine's existing verdict-presence validate seam,
so no runner is excluded. The result-envelope MECHANISM for a schema-less runner is an engine-injected `submit_result`
tool (the `tool-call` tier) whose call arguments are the structured result. The exact contracts are in the three specs.

This refines, but does not replace, the [runner contract](../runner-contract.md): the runner boundary, timeout
policy, and transient-retry policy there are unchanged. ADR-0004 only relocates *which* runner facts are code
versus data, and pins that resolution for replay.

### Replay determinism (load-bearing invariant)

Capability resolution — the `stdoutParser` id, the `permissionStyle` id, the resolved `capabilities` block, plus a
manifest `digest` and `version` — is **snapshotted into the route decision (`RouteRoleBinding` inside
`RouteDecision`) at route time and read FROM THAT PIN on replay**. The route is already a DBOS workflow argument
and therefore durable on recovery (`DataDrivenTaskOpts.route`, `src/pipeline/data-driven-task.workflow.ts:94`; the
sibling pinned fields are documented as "a DBOS workflow arg ⇒ durable on recovery" / "pinned before DBOS workflow
enqueue so recovery cannot branch on changed process env", `:92-98`). The live manifest registry is **NEVER
consulted during workflow execution or DBOS recovery**.

The snapshot is self-contained: it carries the full `stdoutParser` id, `permissionStyle` id, and `capabilities`
block, so replay/recovery reads everything from the snapshot and never does a content-address lookup-by-digest. The
manifest `digest` is **AUDIT / mismatch-detection only** — a stable hash over the canonicalized manifest; a later
digest mismatch is an operator/audit signal, never a replay input. Pinning makes the routing DECISION
deterministic; it does NOT make the external CLI's behavior deterministic (CLI version, locale, env are not
pinned). The standard DBOS external-effect caveat (a step re-executed after the external world changed can diverge)
applies and is explicitly out of this ADR's scope.

The exact replay model (which fields are consumed in the deterministic body vs. inside the memoized `runStep`
effect, and why each is pinned) is in [runner-manifest-v1.spec.md](../specs/runner-manifest-v1.spec.md).

## Examples

- A new runner that reuses `(jsonl-exec, sandbox-enum)` is a config-only PR: one manifest, zero source diff.
- A `tool-call`-tier runner whose provider ignores forced `tool_choice` degrades to the `prompt-only` floor within
  the same attempt; only output with no usable verdict fails the node to `revo.ResultInvalid`.
- A run started against manifest digest `D` continues, replays, and recovers against `D`, even after an operator
  edits or replaces the manifest mid-run.

## Alternatives

- **Status quo — one bespoke code adapter per runner plus engine `switch`/`if` branches.** Rejected: O(runners)
  engine surgery (~5 edit sites across 2 files per runner) and it directly blocks #184 / #187 / #168.
- **Fully data-driven — eliminate all per-runner parser code** via either an untyped extraction DSL / JSONPath /
  rules engine, or a typed declarative mapper / parser-combinator. Rejected for both. The untyped form relocates
  code into a worse, untyped form and turns parser bugs into config-debugging. The typed form still loses:
  combinators pay off on *uniform* grammars, but each CLI frames its result as a heterogeneous per-vendor event
  tree with no shared grammar (the honest example is the ~115-line bespoke Codex reduction at
  `src/worker/codex-runner.ts:261-376`), so a combinator adds an abstraction layer without removing the per-vendor
  work.
- **Hybrid — code-strategy layer (O(parsers)+O(styles)) + manifest data (O(runners)). Chosen.** Code grows only
  with a new `stdoutParser` or `permissionStyle`; runners reusing an existing pair are pure config.

## Consequences

- **Acceptance bar.** A runner sharing an existing `(stdoutParser, permissionStyle)` pair is added by a
  manifest-only change with ZERO code edits, proven by a test (a new manifest reusing an existing pair routes,
  builds args, and parses output with no source diff). Until that test is green in CI, the refactor is not done.
- `RouteRoleBinding` gains snapshot fields — a named schema change, not a silently deferred one (see the manifest
  spec Target Migration).
- The system-entity ids (`stdoutParser`, `permissionStyle`) become a public versioned contract once manifests
  reference them: a behavior-changing parser or style ships as a NEW id; renaming or removing one migrates every
  manifest that references it. Plugin-API discipline (full policy in the manifest spec).
- The audit's runner-id hardcode theme is resolved: the four branch functions and the dispatch switch collapse into
  manifest lookups; the Codex provider throw becomes declarative `constraints.allowedProviders`.
- The integrator `script:`-ref branching (`src/pipeline/data-driven-task.workflow.ts:1361-1394`) is a related but
  separate hardcode theme, NOT resolved here; recorded as a follow-up.
- The existing validate seam is unchanged; the structured-output tier changes how often that seam FAILS a node to
  `revo.ResultInvalid` (a terminal failure), not how often a node retries — retries are governed by the separate
  transient/`needsHuman` machinery.

## Open Questions

- Where manifests live and load from (control-plane table, shipped config file, or both with override precedence)
  belongs to the registry decision (#186); flagged here because the system-entity contract depends on it.
- Do `kind=api` / `kind=gateway` need capability fields beyond `authMode` / `provider`, or does the parser/style
  pair fully capture the difference? Defer until the first non-`cli` runner lands.
- Is `privacyClass` a closed enum (`external` | `self-hosted` | `local`) or an open tag set? Closed enum proposed.
- For `tool-call`-tier runners, is `submit_result` always engine-injected, or may a manifest opt a runner out?
  Defer until the first `tool-call` runner (OpenCode) lands.
