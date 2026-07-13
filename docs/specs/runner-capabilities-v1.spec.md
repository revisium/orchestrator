# Runner capabilities v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** engine (pipeline), runner adapters (worker)
- **Source files:** `src/pipeline/route-contract.ts`, `src/pipeline/data-driven-task.workflow.ts`,
  `src/worker/codex-runner.ts`, `src/worker/runner-dispatch.ts`, `src/control-plane/definitions.ts`,
  `src/pipeline/pipeline.service.ts`
- **Related ADRs:** [ADR-0004](../adr/0004-runner-execution-contract.md),
  [ADR-0012](../adr/0012-acp-process-and-session-isolation.md), [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md)
- **Related specs:** [execution plan v1](./execution-plan-v1.spec.md),
  [resources, workspaces, and effects v1](./resources-workspaces-effects-v1.spec.md),
  [script runtime v1](./script-runtime-v1.spec.md)

## Scope

This spec enumerates every field of a manifest's `capabilities` block — type, meaning, and the exact hardcoded
behavior it replaces.

It does not govern selection (which runner satisfies a run's requirements); selection (#170) is the primary
consumer of this vocabulary. The manifest field schema and the StdoutParser/PermissionStyle contracts are in
[runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md); the structured-output tier is in
[runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

`kind` (`cli` | `api` | `gateway`) is not a capability — it is the transport class and lives as a top-level manifest
field. System scripts have their own definition/registry contract and are not deterministic runner manifests.

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

Each capability field is declarative manifest data. Current-vs-target: the branch functions above ship today; the
`capabilities` block below is the proposal after composition with ADR-0010/0011. Runner manifests state ability.
Portable pipeline resources and node requirements state desired access/capture; script manifests state operation
effects. The target deletes runner-driven preflight/workspace/effect policy rather than encoding it as capability data.

### Capability fields

| Field | Type | Meaning |
|---|---|---|
| `provider` | string | Provider family the runner targets (e.g. `anthropic`, `openai-compatible`, `provider-gateway`). Data; recorded in provenance. Keep concrete account/model names out (canonical-method discipline). |
| `authMode` | enum `cli-session`\|`api-key`\|`gateway-token`\|`provider-config`\|`none` | How the runner authenticates. `provider-config` means a provider gateway such as OpenCode resolves credentials from its existing config for the pinned model profile. Used by selection, host doctor, and explicit plan-compilation availability checks; it does not imply workspace policy. |
| `privacyClass` | enum `external`\|`self-hosted`\|`local`\|`profile` | Data-egress class of the provider. `profile` means the effective class is resolved and pinned from the selected model profile rather than fixed by the runner. Lets routing/profile policy exclude external providers for sensitive runs. Consumed by selection (#170), not by this spec. |
| `supportsWorkspaceWrite` | boolean | Whether the runner can write the worktree at all. Distinct from per-role permission: a read-only role on a write-capable runner is fine. Relates to Codex `sandbox-enum` (`src/worker/codex-runner.ts:144-155`). |
| `supportsStructuredOutput` | enum `native-schema`\|`tool-call`\|`prompt-only` | The structured-output tier (not a boolean). Defined in [runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md). Routing may require a minimum tier. |

### One-to-one replacement of the hardcoded functions

| Capability field | Replaces (hardcoded today) | Today's behavior to preserve |
|---|---|---|
| Node access/capture declarations (resources-workspaces-effects-v1; not runner capabilities) | `runnerNeedsLivePreflight(runnerId)` and `runnerProducesWorktreeChanges(runnerId)` | Deleted in the target. Plan compilation validates selected runner ability against declared access; capture follows node declarations. |
| Script definition manifests (script-runtime-v1; not runner capabilities) | Former merge/integrator/script branches | Deleted in the target. Git/GitHub effects are explicit script definitions. |
| `stdoutParser` + `permissionStyle` (manifest ids, not under `capabilities`) → registry lookup | `dispatchRunnerId(runnerId)` switch (`src/pipeline/route-contract.ts:110-114`) consumed at `src/pipeline/pipeline.service.ts:470`, and `switch (role.runner)` (`src/worker/runner-dispatch.ts:8-20`) | `stub-agent`→`script`; `claude-code`/`codex`/`script` pass through; unknown ids remain unknown and fail at dispatch. After: resolve the manifest by `runner.id`, dispatch by its `(stdoutParser, permissionStyle)` pair. |
| `constraints.allowedProviders` (manifest, see manifest spec) | `requireCompatibleProfile(profile)` throw (`src/worker/codex-runner.ts:179-186`, `isOpenAiCompatibleProvider` at `:109-112`) | Codex rejects a non-OpenAI-compatible provider. After: declarative provider match; a mismatch is a typed precondition failure routed to a lesson, not a hard throw inside the adapter. |
| default-runner config id | literal `'claude-code'` default in `loadRole` (`src/control-plane/definitions.ts:112`) | A role row with no `runner_id`/`runner` defaults to `claude-code`. After: the default runner id is named config, not a literal in `loadRole`. |

## Validation

- **Boundary replacement test.** A test proves selected runner abilities reproduce the relevant adapter compatibility
  behavior, while the removed hardcoded preflight/change-capture branches are replaced by execution-plan resource and
  node declarations. Built-in Git/GitHub behavior is proven through script definitions, not runner fields.
- **Ability fields are pinned for replay.** Provider/auth/privacy, workspace-write support, and structured-output tier
  are part of the complete `runnerManifest` snapshot in the route binding (see runner-manifest-v1). A separate test
  asserts node access/capture and script effects are read from the execution plan, not inferred from runner data.
- **Unknown-id load error.** A manifest with an unmapped `stdoutParser`/`permissionStyle` is a load-time error
  (mirrors `RUNNER_NOT_IMPLEMENTED`, `src/worker/runner-dispatch.ts:12,16,19`).

## Compatibility

`capabilities` is additive manifest data. Adding a new optional ability field is backward-compatible only with an
explicit conservative selection default. The capability
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
  "supportsStructuredOutput": "native-schema"    // --json-schema (claude-code-runner.ts:159)
}
```

### codex (`kind: "cli"` on the manifest)

```jsonc
{
  "provider": "openai-compatible",                // constraints.allowedProviders: ["openai","codex"]
  "authMode": "cli-session",
  "privacyClass": "external",
  "supportsWorkspaceWrite": true,                 // sandbox-enum workspace-write (codex-runner.ts:144-155)
  "supportsStructuredOutput": "native-schema"     // --output-schema (codex-runner.ts:161-162)
}
```

### opencode (anticipated — not yet implemented; `kind: "gateway"` on the manifest)

```jsonc
{
  "provider": "provider-gateway",
  "authMode": "provider-config",
  "privacyClass": "profile",
  "supportsWorkspaceWrite": false,
  "supportsStructuredOutput": "prompt-only"       // only "no --json-schema flag" is proven; tool-call unverified
}
```

`privacyClass: profile` is a route-resolution marker, not a value that may remain unresolved in a DBOS workflow.
Before enqueue, route resolution MUST replace it with the concrete `external`, `self-hosted`, or `local` value from the
selected model profile policy. Missing or unknown values MUST resolve conservatively to `external`. The concrete value,
not the marker, is pinned for replay.

OpenCode is classified `prompt-only` until tool-call support (forced `tool_choice` / a `submit_result`-style tool)
is verified by a live probe; it is not asserted to be `tool-call` today. If a probe later confirms tool support,
the tier is promoted to `tool-call`, which degrades to the `prompt-only` floor per
[runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md).

> Informative: no `opencode`/`acp` code exists in the orchestrator today, so these values are unverified against
> source. They come from a live CLI probe (2026-06-29: `opencode run --format json`, no schema flag; `opencode
> models` lists `provider/model`; a session model carries
> `providerID`/`modelID`/`tokens{input,output,reasoning,cache}`/`cost`). Only "no schema flag" is proven.
> `provider-config` and `privacyClass: profile` are required because the same OpenCode process can route a local model
> or an external provider; the runner alone cannot truthfully pin either value. Workspace write remains disabled until
> ACP permission allow/deny/tool-scope conformance passes.

### System scripts are not runner capabilities

Built-in Git/GitHub operations are `ScriptDefinition` values governed by script-runtime-v1. Run profiles bind
runner/model choices for agents and credential aliases for named resources; they do not turn scripts into runners.

## Changelog

- 2026-07-11: Removed target runner-driven preflight, capture, and merge policy; runner manifests now state ability,
  while execution-plan node requirements and script definitions own desired behavior.
- 2026-07-10: Corrected the OpenCode ACP transport to `kind: cli`, made provider auth/privacy profile-dependent, and
  kept workspace write disabled until permission conformance passes.
- 2026-07-09: Clarified that built-in Git/GitHub behavior is selected by pipeline `scriptRef`, not by
  runner ids; removed old integrator/merger runner-id semantics and kept unknown script/runner selection fail-closed.
- 2026-06-29: Initial version.
