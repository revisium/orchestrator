# ADR-0006 - Run profiles and provider-neutral feature-development

- **Status:** Draft
- **Decision date:** 2026-07-03
- **Specs:** [run profiles v1](../specs/run-profiles-v1.spec.md)
- **Relates-to:** [pipeline state machine v1](../specs/pipeline-state-machine-v1.spec.md),
  [default playbook policy](../specs/default-playbook-policy.spec.md),
  [runner capabilities v1](../specs/runner-capabilities-v1.spec.md),
  [runner manifest v1](../specs/runner-manifest-v1.spec.md),
  [playbook storage v1](../specs/playbook-storage-v1.spec.md)

## Context

The default feature-development path needs to be usable with different runner/provider mixes without duplicating the
pipeline graph. The current implementation already has the first pieces:

- the pipeline grammar has `parallel` and `join` nodes;
- `materializeTemplate` can clone selected agent nodes into deterministic fanout plus join topology;
- `CODEX_CONSENSUS_PROFILE` materializes reviewer consensus for `planReviewer` and `codeReview`;
- route decisions stamp `profileId`, `profileHash`, `materializedTemplateHash`, and binding provenance;
- MCP accepts `profileId` and `executionProfile` on `create_run` / `simulate_route`.

That shape is still too hard to reason about as a public protocol. It has a legacy pipeline alias
`feature-development-codex-consensus`; concrete runner binding is split between `profileId` and `executionProfile`;
the public MCP surface does not teach a caller how to discover or design a profile; and profile materialization is
limited to hardcoded reviewer fanout.

The intended operator experience is:

1. choose the canonical `feature-development` pipeline;
2. choose an existing run profile or provide an inline run profile;
3. inspect runner/model capability metadata through MCP before launch;
4. launch a run whose materialized graph, profile snapshot, runner bindings, and capability snapshot are pinned for
   replay.

## Decision

Adopt `RunProfile` as the public launch-time customization contract for provider selection, model levels, fanout,
joins, consensus review, synthesis, and implementation-candidate selection.

### Pipeline identity

- `feature-development` is the only canonical default feature-development pipeline id.
- Provider or topology variants MUST NOT be exposed as pipeline ids.
- `feature-development-codex-consensus` is a legacy compatibility alias to remove from the public catalog and MCP
  examples. Existing stored runs MAY keep their pinned route decision and requested pipeline id for audit.
- New launches MUST use `pipelineId: "feature-development"` plus either `profileId` or an inline `profile`.

### Provider-neutral pipeline

The base pipeline describes workflow semantics only: analysis, plan review, plan gate, development, code review,
integration, PR readiness, merge gate, recovery, and cleanup. Agent nodes name semantic capabilities or binding slots;
they do not encode provider identities, model names, or multi-provider consensus by duplicating graph variants.

Concrete diversity belongs to the selected profile:

- runner id (`codex`, `claude-code`, `opencode`, `revo-integrator`, etc.);
- model level or concrete model key, as exposed by runner capabilities;
- permission mode, timeout, and budget;
- fanout lanes and their bindings;
- deterministic join and review reducers;
- optional post-join agent/human/script selection steps.

### Explicit launch profile

`create_run` and `simulate_route` MUST require exactly one profile source for provider/model/topology customization:

- `profileId` references a stored, versioned run profile;
- `profile` supplies an inline run profile.

The server MUST NOT silently auto-select a default profile. If neither field is present, MCP returns a profile-required
response with candidate profiles, runner capabilities, and profile-design guidance, and creates no run.

Seeded profiles MAY exist for convenience, but they are choices, not defaults. A future installation can seed profiles
such as `codex-standard`, `claude-standard`, `codex-claude-review-consensus`,
`analytics-codex-claude-opencode`, and `developer-codex-opencode-candidates`.

### Profile composition

A run profile owns two related concerns:

- topology overlays: which semantic stages are single-lane, review consensus, proposal consensus, implementation
  candidates, or post-join synthesis;
- bindings: which runner/model/permission/budget settings apply to slots, lanes, and post-join nodes.

This intentionally replaces the current split where `profileId` changes topology and `executionProfile` changes
bindings. `executionProfile` can remain as an internal or compatibility seam during migration, but the public MCP
contract should expose one `profile` concept.

### Join and after-join behavior

`join` remains deterministic runtime topology, not an arbitrary user script. A profile can then route the joined
bundle to an explicit next step:

- an agent that synthesizes analysis or chooses an implementation candidate;
- a human gate that selects/adopts/rejects candidates;
- a script that validates or adopts a candidate;
- a choice/router that dispatches from a structured verdict.

The runtime must preserve enough branch output data for that next step. A verdict-only join is sufficient for simple
review consensus, but proposal synthesis and implementation-candidate selection require a durable branch-output bundle.

### Replay and provenance

A run MUST pin:

- profile source (`profileId` or inline), profile version, profile snapshot, and `profileHash`;
- materializer version and materialized graph hash;
- resolved runner/model/permission/timeout bindings per role, node, and lane;
- runner capability snapshot used for validation;
- playbook version and base pipeline version.

Recovery and replay MUST use those pins. They MUST NOT re-materialize from the latest stored profile or latest runner
capability catalog unless an explicit migration/rebase command creates a new run or new route decision.

### MCP profile ergonomics

MCP must make profile design discoverable. The capability surface should expose:

- profile schema and examples;
- seeded stored profiles;
- stored-profile creation and versioning;
- available runners, model levels, permissions, and capability flags;
- validation/simulation diagnostics before launch;
- clear remediation when a caller tries the removed legacy alias or omits a profile.

## Alternatives

- **Keep provider variants as pipeline ids.** Rejected. It duplicates control-flow policy, makes default-policy
  validation drift-prone, and hides that provider/model selection is a launch concern.
- **Keep `profileId` for topology and `executionProfile` for bindings as public API.** Rejected for MCP ergonomics.
  It forces callers to understand an implementation split and makes provenance harder to explain.
- **Auto-select a default profile.** Rejected. Revo runs change real repositories; provider/model/runtime selection
  must be explicit and reviewable.
- **Make join an arbitrary script hook.** Rejected as the base primitive. Deterministic join remains part of the
  runtime graph. Scripts, agents, and human gates can run after the join using the joined bundle.
- **Store only profile id and re-read it on replay.** Rejected. It violates replay safety when stored profiles or
  runner catalogs evolve.

## Consequences

- The bundled catalog should expose `feature-development` as the canonical default pipeline and stop advertising
  provider-specific aliases for new launches.
- MCP tools and instructions need profile-oriented discovery and validation.
- Stored profiles need a versioned row shape or an evolution of the existing `model_profiles` row class.
- The topology materializer needs to grow from hardcoded consensus toggles to a profile-driven stage model.
- Branch execution and join outputs need a bundle form for synthesis, selector agents, human selection, and candidate
  adoption.
- Route decisions and run-created events need to carry enough profile and capability snapshot data for debugging and
  replay.

## Validation

Implementing PRs should add focused tests for:

- `create_run` rejects missing profile with a profile-required response and creates no run;
- `create_run` accepts exactly one of `profileId` or inline `profile`;
- `feature-development-codex-consensus` is not listed as a public launch pipeline and returns a migration diagnostic
  if requested;
- profile validation rejects unknown runners, models, permission modes, duplicate lane ids, unresolved slots, and
  unsafe implementation-candidate topology;
- route simulation returns the same materialized graph/provenance that run creation pins;
- replay uses the pinned profile snapshot, graph hash, bindings, and capability snapshot after the stored profile is
  modified;
- profile-driven review consensus can run plan review and code review with independent lane bindings;
- proposal consensus can route a branch-output bundle to a synthesis agent;
- implementation-candidate consensus uses isolated worktrees and an explicit adoption/selection step;
- MCP `get_capabilities` advertises profile requirements and does not expose removed legacy observation/profile
  shortcuts.

## Open Questions

- Whether the persistent table should be renamed from `model_profiles` to `run_profiles`, or whether a typed
  `kind: "run-profile/v1"` payload inside `model_profiles` is sufficient for migration.
- Whether seeded profile ids should be installed by default or exposed as example templates until the runner catalog
  is complete.
- How much of runner capability discovery should come from local runner manifests versus live provider probes.
- Whether implementation-candidate selection should ship first with human adoption only, then add agent/script
  selectors after branch-output bundles are stable.
