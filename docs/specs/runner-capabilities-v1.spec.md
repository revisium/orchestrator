# Runner capabilities v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** engine (pipeline), runner adapters (worker)
- **Source files:** `src/pipeline/route-contract.ts`, `src/pipeline/data-driven-task.workflow.ts`,
  `src/worker/codex-runner.ts`, `src/worker/runner-dispatch.ts`, `src/control-plane/definitions.ts`,
  `src/pipeline/pipeline.service.ts`
- **Related ADRs:** [ADR-0004](../adr/0004-runner-execution-contract.md), [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md)

## Scope

This spec enumerates every field of a manifest's `capabilities` block — type, meaning, and the exact hardcoded
behavior it replaces.

It does not govern selection (which runner satisfies a run's requirements); selection (#170) is the primary
consumer of this vocabulary. The manifest field schema and the StdoutParser/PermissionStyle contracts are in
[runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md); the structured-output tier is in
[runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

`kind` (`cli` | `api` | `gateway` | `deterministic-script`) is not a capability — it is the transport class and
lives as a top-level manifest field. It is data, not a code-dispatch key, and appears exactly once, on the
manifest, never under `capabilities`.

Paths under `src/...` are relative to the `@revisium/orchestrator` package root.

## Current Contract

Today there is no `capabilities` block. The same decisions live as hardcoded branch functions on literal runner ids
(verified shipped behavior):

- `runnerNeedsLivePreflight(runnerId)` returns `true` for agent runners `'claude-code'` and `'codex'`.
  Built-in Git/GitHub scripts are selected by `scriptRef`; they are not modeled as fake runner ids.
- `runnerProducesWorktreeChanges(runnerId)` returns `true` for `'claude-code'`, `'codex'`
  (`src/pipeline/data-driven-task.workflow.ts:358-360`); consumed at `:1128` (change capture).
- `dispatchRunnerId(runnerId)` switch (`src/pipeline/route-contract.ts:110-114`) consumed at
  `src/pipeline/pipeline.service.ts:470`, and `switch (role.runner)` (`src/worker/runner-dispatch.ts:8-20`) — two
  surfaces of the same dispatch decision.
- `requireCompatibleProfile(profile)` throws for a non-OpenAI-compatible provider
  (`src/worker/codex-runner.ts:179-186`, `isOpenAiCompatibleProvider` at `:109-112`).
- The default runner id is the literal `'claude-code'` in `loadRole` (`src/control-plane/definitions.ts:112`).

The structured-output reliability difference between runners is not modeled today — both live runners have a
native schema flag.

## Target Migration

Each capability field is declarative manifest data. Current-vs-target: the branch functions above ship today;
the `capabilities` block below is the proposal (ADR-0004 is Status: Draft).

### Capability fields

| Field | Type | Meaning |
|---|---|---|
| `provider` | string | Provider family the runner targets (e.g. `anthropic`, `openai-compatible`, `provider-gateway`). Data; recorded in provenance. Keep concrete account/model names out (canonical-method discipline). |
| `authMode` | enum `cli-session`\|`api-key`\|`gateway-token`\|`none` | How the runner authenticates. Feeds `needsLivePreflight` doctor checks. |
| `privacyClass` | enum `external`\|`self-hosted`\|`local` | Data-egress class of the provider. Lets routing/profile policy exclude external providers for sensitive runs. Consumed by selection (#170), not by this spec. |
| `supportsWorkspaceWrite` | boolean | Whether the runner can write the worktree at all. Distinct from per-role permission: a read-only role on a write-capable runner is fine. Relates to Codex `sandbox-enum` (`src/worker/codex-runner.ts:144-155`). |
| `supportsStructuredOutput` | enum `native-schema`\|`tool-call`\|`prompt-only` | The structured-output tier (not a boolean). Defined in [runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md). Routing may require a minimum tier. |
| `needsLivePreflight` | boolean | Whether the runner requires a live auth/binary/reachability probe before dispatch. |
| `performsMerge` | boolean | Not used for built-in Git/GitHub scripts; script behavior is selected by the pipeline node `scriptRef`. |
| `producesWorktreeChanges` | boolean | Whether a successful run is expected to leave file changes in the worktree (so the engine captures a `change` artifact). |

### One-to-one replacement of the hardcoded functions

| Capability field | Replaces (hardcoded today) | Today's behavior to preserve |
|---|---|---|
| `needsLivePreflight` | `runnerNeedsLivePreflight(runnerId)` | `true` for `claude-code` and `codex`. |
| `performsMerge` | Removed runner branch | Built-in Git/GitHub behavior is a system script selected by `scriptRef`, not by runner id. |
| `producesWorktreeChanges` | `runnerProducesWorktreeChanges(runnerId)` (`src/pipeline/data-driven-task.workflow.ts:358-360`) | `true` for `claude-code`, `codex`. Consumed at `:1128` (change capture). |
| `stdoutParser` + `permissionStyle` (manifest ids, not under `capabilities`) → registry lookup | `dispatchRunnerId(runnerId)` switch (`src/pipeline/route-contract.ts:110-114`) consumed at `src/pipeline/pipeline.service.ts:470`, and `switch (role.runner)` (`src/worker/runner-dispatch.ts:8-20`) | `stub-agent`→`script`; `claude-code`/`codex`/`script` pass through; unknown ids remain unknown and fail at dispatch. After: resolve the manifest by `runner.id`, dispatch by its `(stdoutParser, permissionStyle)` pair. |
| `constraints.allowedProviders` (manifest, see manifest spec) | `requireCompatibleProfile(profile)` throw (`src/worker/codex-runner.ts:179-186`, `isOpenAiCompatibleProvider` at `:109-112`) | Codex rejects a non-OpenAI-compatible provider. After: declarative provider match; a mismatch is a typed precondition failure routed to a lesson, not a hard throw inside the adapter. |
| default-runner config id | literal `'claude-code'` default in `loadRole` (`src/control-plane/definitions.ts:112`) | A role row with no `runner_id`/`runner` defaults to `claude-code`. After: the default runner id is named config, not a literal in `loadRole`. |

## Validation

- **One-to-one parity test.** A test asserts each capability field reproduces its hardcoded predecessor's behavior
  for the live runner ids (e.g. `claude-code`/`codex` → `needsLivePreflight: true`,
  built-in Git/GitHub script behavior is selected by `scriptRef`, `claude-code`/`codex` →
  `producesWorktreeChanges: true`), so the migration is provably behavior-preserving.
- **Capability fields are pinned for replay.** `needsLivePreflight` / `performsMerge` /
  `producesWorktreeChanges` are consumed in the deterministic workflow body and MUST be snapshotted into the route
  binding (see [runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md) Replay model); a test asserts an
  in-flight run reads them from the pin, not the registry.
- **Unknown-id load error.** A manifest with an unmapped `stdoutParser`/`permissionStyle` is a load-time error
  (mirrors `RUNNER_NOT_IMPLEMENTED`, `src/worker/runner-dispatch.ts:12,16,19`).

## Compatibility

`capabilities` is additive manifest data. Adding a new capability field is backward-compatible, and the engine
MUST default a missing capability field conservatively (e.g. `producesWorktreeChanges: false`). The capability
vocabulary is a stable contract its primary consumer (#170 selection) reads; renaming or removing a field is a
breaking change. This spec refines the [runner contract](../runner-contract.md) without contradicting it.

## Examples

Grounded in the two live adapters. These are the `capabilities` objects only; `kind` is a sibling manifest field
(shown in the comment), not a capability.

### claude-code (`kind: "cli"` on the manifest)

```jsonc
{
  "provider": "anthropic",
  "authMode": "cli-session",
  "privacyClass": "external",
  "supportsWorkspaceWrite": true,
  "supportsStructuredOutput": "native-schema",   // --json-schema (claude-code-runner.ts:159)
  "needsLivePreflight": true,                     // route-contract.ts:117
  "performsMerge": false,                         // built-in Git/GitHub scripts are selected by scriptRef
  "producesWorktreeChanges": true                 // data-driven-task.workflow.ts:359
}
```

### codex (`kind: "cli"` on the manifest)

```jsonc
{
  "provider": "openai-compatible",                // constraints.allowedProviders: ["openai","codex"]
  "authMode": "cli-session",
  "privacyClass": "external",
  "supportsWorkspaceWrite": true,                 // sandbox-enum workspace-write (codex-runner.ts:144-155)
  "supportsStructuredOutput": "native-schema",    // --output-schema (codex-runner.ts:161-162)
  "needsLivePreflight": true,                     // route-contract.ts:117
  "performsMerge": false,
  "producesWorktreeChanges": true                 // data-driven-task.workflow.ts:359
}
```

### opencode (anticipated — not yet implemented; `kind: "gateway"` on the manifest)

```jsonc
{
  "provider": "provider-gateway",
  "authMode": "gateway-token",
  "privacyClass": "external",
  "supportsWorkspaceWrite": true,
  "supportsStructuredOutput": "prompt-only",      // only "no --json-schema flag" is proven; tool-call unverified
  "needsLivePreflight": true,
  "performsMerge": false,
  "producesWorktreeChanges": true
}
```

OpenCode is classified `prompt-only` until tool-call support (forced `tool_choice` / a `submit_result`-style tool)
is verified by a live probe; it is not asserted to be `tool-call` today. If a probe later confirms tool support,
the tier is promoted to `tool-call`, which degrades to the `prompt-only` floor per
[runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md).

> Informative: no `opencode`/`acp` code exists in the orchestrator today, so these values are unverified against
> source. They come from a live CLI probe (2026-06-29: `opencode run --format json`, no schema flag; `opencode
> models` lists `provider/model`; a session model carries
> `providerID`/`modelID`/`tokens{input,output,reasoning,cache}`/`cost`). Only "no schema flag" is proven.

### script / stub-agent (deterministic; `kind: "deterministic-script"` on the manifest)

```jsonc
{
  "provider": "none",
  "authMode": "none",
  "privacyClass": "local",
  "supportsWorkspaceWrite": true,                 // the real integrator writes git/gh
  "supportsStructuredOutput": "native-schema",    // it emits a typed result directly
  "needsLivePreflight": false,                    // script selection is separate from runner preflight
  "performsMerge": false,                         // merge behavior is not selected by runner id
  "producesWorktreeChanges": false                // integrator produces a PR, not worktree edits
}
```

Built-in Git/GitHub scripts such as `script:integrator` and `script:confirmMerge` are selected by pipeline node
`scriptRef`. Run profiles may bind script-node launch data, such as `accounts.github`, but they do not turn scripts
into runners.

## Changelog

- 2026-06-29: Initial version.
