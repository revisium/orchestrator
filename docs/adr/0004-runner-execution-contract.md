# ADR-0004 - Runner execution contract

- **Status:** Draft
- **Decision date:** 2026-06-29
- **Specs:** [runner manifest v1](../specs/runner-manifest-v1.spec.md),
  [runner result envelope v1](../specs/runner-result-envelope-v1.spec.md),
  [runner capabilities v1](../specs/runner-capabilities-v1.spec.md),
  [ACP runner session v1](../specs/acp-runner-session-v1.spec.md)
- **Refines:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md) (data-driven pipeline state machine)
- **Relates-to:** [runner contract](../runner-contract.md),
  [script runtime v1](../specs/script-runtime-v1.spec.md),
  [execution plan v1](../specs/execution-plan-v1.spec.md)

## Context

ADR-0002 made the engine generic: `src/pipeline-core/` knows no role ids or pipeline shapes, and runner choice is
meant to hide behind `role.runner`. That boundary does not hold today. Runner conventions leak into the generic
engine as hardcoded branches on literal runner ids — roughly five synchronized decision sites across two files
(for example, `dispatchRunnerId` branching on `'stub-agent'`/`'claude-code'`/`'codex'`/`'script'` in
`src/pipeline/route-contract.ts`), plus a Codex adapter that rejects any non-OpenAI-compatible provider with a hard
throw. The remaining sites are enumerated in the linked specs and the implementing PR.

Adding a runner today therefore means editing the engine at every one of those sites, even when the new runner is
the same protocol shape as an existing one. This blocks Codex hardening (#184), an OpenCode runner (#187), and
run profiles (#168).

The variation between runners is not uniform. Some of it is irreducibly code — each vendor frames its output as a
different event tree — and some is pure data: flag names, schema delivery mechanism, the rights-to-sandbox table.
The engine treats all of it as code, in the wrong layer.

## Decision

Adopt a three-layer runner model that splits runner knowledge by what genuinely varies, so the engine grows by
the number of code strategies (a small set of `protocolDriver`, `stdoutParser`, and `permissionStyle` ids), not by
the number of runners.

- **Layer 1 — code strategies.** A closed registry of code strategies, referenced by id, on three orthogonal axes.
  `protocolDriver` coordinates an interactive request/response protocol over an executor-owned transport; one-shot
  CLI runners use the built-in `one-shot` driver. `stdoutParser` is a pure function from already captured output to
  a normalized result. `permissionStyle` maps portable `role.rights` and `role.allowedTools` to the runner's native
  permission expression. A manifest references the three ids independently; there is no bundled `family` id. Code
  is added only when a new driver, parser, or style appears.
- **Layer 2 — runner manifest (data).** A declarative record binding a concrete runner to a `protocolDriver` id, a
  `stdoutParser` id, a `permissionStyle` id, and declarable fields. Adding a runner that reuses an existing
  `(protocolDriver, stdoutParser, permissionStyle)` triple is a pure manifest change with no engine code.
- **Layer 3 — profile and registry (selection).** Which runner a role resolves to, per profile, and the registry
  that holds manifests, are a separate decision (#169 / #170 / #186, a future selection ADR). This ADR defines the
  contract a selected runner must satisfy; it does not define selection.

The runner-id branch functions and the provider throw become declarative `capabilities` and `constraints` manifest
data. Schema-less runners are not excluded: structured output degrades to a prompt-only floor that leans on the
engine's existing verdict-presence validate seam, with the degradation mechanism defined in the result-envelope
spec.

This refines, but does not replace, the runner contract: the timeout and transient-retry policy there are
unchanged. ADR-0004 only relocates which runner facts are code versus data, and pins that resolution for replay.

### Replay determinism (load-bearing invariant)

Capability resolution is snapshotted into the route decision at route time and read from that pin on replay; the
route is already a durable DBOS workflow argument, so the live manifest registry is never consulted during workflow
execution or recovery. The snapshot is self-contained, so replay never does a content-address lookup; the manifest
`digest` is audit and mismatch-detection only, never a replay input. Pinning makes the routing decision
deterministic but does not make the external CLI deterministic — its version, locale, and environment are not
pinned, and that external-effect nondeterminism is out of this ADR's scope.

The exact replay model is in [runner-manifest-v1.spec.md](../specs/runner-manifest-v1.spec.md).

## Examples

- A new runner that reuses `(one-shot, jsonl-exec, sandbox-enum)` is a config-only PR: one manifest, zero source diff.
- An ACP runner uses an interactive `acp-stdio-v1` protocol driver while process creation, timeout, termination, and
  reaping remain owned by the shared process executor; see ADR-0010 and the ACP runner session spec.
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
  tree with no shared grammar (the current Codex reduction is centered on `summarizeCodexEvents` in
  `src/worker/codex-runner.ts`), so a combinator adds an abstraction layer without removing the per-vendor work.
- **Hybrid — code-strategy layer (O(drivers)+O(parsers)+O(styles)) + manifest data (O(runners)). Chosen.** Code grows
  only with a new `protocolDriver`, `stdoutParser`, or `permissionStyle`; runners reusing an existing triple are pure
  config.

## Consequences

- Adding a runner that shares an existing `(protocolDriver, stdoutParser, permissionStyle)` triple with no engine diff is the
  conformance test for this contract.
- The route decision gains snapshot fields — a named schema change, not a silently deferred one (see the manifest
  spec target migration).
- The system-entity ids (`protocolDriver`, `stdoutParser`, `permissionStyle`) become a public versioned contract once
  manifests reference them: a behavior-changing driver, parser, or style ships as a new id, and renaming or removing one migrates
  every manifest that references it. Plugin-API discipline; full policy in the manifest spec.
- The audit's runner-id hardcode theme is resolved: the branch functions and the dispatch switch collapse into
  manifest lookups, and the Codex provider throw becomes declarative `constraints.allowedProviders`.
- Script/effect registration and integrator operation decomposition are separate from agent-runner selection and are
  owned by the Draft [script runtime](../specs/script-runtime-v1.spec.md) and
  [resources/workspaces/effects](../specs/resources-workspaces-effects-v1.spec.md) contracts.
- The existing validate seam is unchanged; the structured-output tier changes how often that seam fails a node to
  `revo.ResultInvalid` (a terminal failure), not how often a node retries — retries are governed by the separate
  transient and `needsHuman` machinery.

## Open Questions

- Where manifests live and load from (control-plane table, shipped config file, or both with override precedence)
  belongs to the registry decision (#186); flagged here because the system-entity contract depends on it.
- Do `kind=api` / `kind=gateway` need capability fields beyond `authMode` / `provider`, or does the
  driver/parser/style triple fully capture the difference? Defer until the first non-`cli` runner lands.
- Is `privacyClass` a closed enum (`external` | `self-hosted` | `local`) or an open tag set? Closed enum proposed.
- For `tool-call`-tier runners, is `submit_result` always engine-injected, or may a manifest opt a runner out?
  Defer until the first `tool-call` runner (OpenCode) lands.
- Whether protocol drivers beyond `one-shot` and `acp-stdio-v1` need another transport abstraction is deferred until
  the first API-native interactive runner. Process ownership remains in the shared executor either way.
