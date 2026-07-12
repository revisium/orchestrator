# ADR-0006 - Run profiles and provider-neutral feature-development

- **Status:** Draft
- **Decision date:** 2026-07-03
- **Implementation status:** Storage-backed profiles, inline profile validation, topology/binding materialization, and
  current route pins have substantially landed; the full execution-plan/resource-capability boundary remains Draft.
- **Specs:** [run profiles v1](../specs/run-profiles-v1.spec.md),
  [execution plan v1](../specs/execution-plan-v1.spec.md),
  [resources, workspaces, and effects v1](../specs/resources-workspaces-effects-v1.spec.md),
  [ACP runner session v1](../specs/acp-runner-session-v1.spec.md)
- **Refines:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md)
- **Relates-to:** [ADR-0004](./0004-runner-execution-contract.md),
  [ADR-0005](./0005-versioned-playbook-storage-and-revo-materialization.md),
  [ADR-0010](./0010-acp-process-and-session-isolation.md)

## Context

The default feature-development workflow must support different runner/model mixes without duplicating its graph.
Provider-specific pipeline copies drift because each gate, recovery path, effect, and policy edge must be updated in
parallel.

Revo now stores versioned run profiles and materializes profile topology/bindings into the current Prisma route
decision. That implementation proves the basic direction. It does not yet resolve every runner, script/effect,
resource, playbook, and accepted-context input into the full immutable `ExecutionPlan` proposed by the Draft target.

The current `feature-development` publish-account convenience expands an integrator binding to named PR lifecycle
nodes. That is product-specific implementation behavior, not a generic runtime contract. The generic target must not
know those node ids.

## Draft Decision

Adopt `RunProfile` as the single public launch-configuration shape and keep the base pipeline provider-neutral.

- The pipeline owns workflow semantics: node/edge topology, gates, allowed materialization points, and capability
  slots.
- The profile owns launch choices: topology overlays, role/runner/model bindings, permission/timeout/budget settings,
  and resource/effect bindings allowed by the selected pipeline.
- Provider or topology variants are not separate public pipeline ids.
- Stored and inline profiles use the same validated launch shape. A request selects one or the other, never a second
  competing override object.
- Test runner substitutions are runtime/test execution-profile overrides, not public `runnerMode`, `--stub`, stub
  roles, or alternate production graphs.
- Secrets remain host-local and are never stored in profiles or execution pins. Profiles may reference validated
  account/resource aliases only.

Route planning validates the selected profile against the selected pipeline, resolves every binding/capability, and
places the normalized profile plus resolved values inside the immutable `ExecutionPlan`. Execution and recovery read
that pin rather than the latest profile row or a live runner/effect registry.

Publishing identity is a declared resource/effect binding. A product graph may expose one logical publish slot shared
by its Git/GitHub operations, but the generic materializer resolves graph-declared capability references; it does not
carry a hardcoded list of `feature-development` node ids. The current named-node expansion is replaced directly when
the resources/effects contract lands.

Profiles are versioned meaning in the embedded Revisium engine. Editing an imported default creates an explicit
versioned customization/derived value; it must not rely on silent catalog reconciliation that mutates an immutable
installed playbook version.

## Current and Target Boundary

Current code already provides storage-backed profile discovery/mutation, catalog-seeded defaults, inline profile
simulation/launch, template materialization, profile hashes, resolved launch bindings, and Prisma route provenance.
Those are shipped implementation facts while this ADR remains Draft.

The Draft target adds the complete execution pin, generic resource/effect binding, immutable playbook-version
relationship, and removal of domain-node expansion from generic runtime code. Acceptance requires the Draft specs and
implementation to agree; landed subsets do not change this ADR's status.

ADR-0010 and the ACP runner session spec require that complete pin to include the resolved model-profile snapshot
before DBOS enqueue. An ACP replacement invocation must use the pinned provider, model, params, privacy, and pricing
rather than re-read mutable model-profile meaning. ACP dispatch remains nonconformant until that execution-plan field
and its runtime consumption land.

## Direct Cutover

The internal alpha target does not preserve provider-specific pipeline aliases, TypeScript profile registries,
fallback defaults, dual launch objects, or a public stub/live fork. Current domain-node account expansion is not a
compatibility requirement.

## Alternatives

- **Duplicate pipelines per provider/topology.** Rejected because workflow policy drifts.
- **Keep profiles in TypeScript constants.** Rejected because launch policy would be hidden from versioned meaning and
  product discovery.
- **Store only a profile id in a run.** Rejected because replay would change when the profile changes.
- **Expose profile plus arbitrary launch overrides.** Rejected because two competing configuration objects make
  provenance and validation ambiguous.
- **Store credentials in profile data.** Rejected because profiles are versioned/listable meaning, not a secret store.
- **Teach generic runtime every PR lifecycle node id.** Rejected because product graph semantics belong to graph data.

## Consequences

- One `feature-development` pipeline supports multiple runner/model/topology selections.
- Profile mutation and simulation use the same semantic validator as launch.
- Route planning fails before run start when a capability/resource cannot be resolved.
- Replay remains stable after later profile, registry, or account-alias changes because resolved non-secret identity is
  pinned.
- Product graphs declare logical binding groups; generic runtime materializes them without domain-node knowledge.
- Exact profile schema, hashes, mutation concurrency, lifecycle, validation errors, and API fields stay in the linked
  specs.

## Open Questions

- Which profile schema version first references the generic resource/effect capability model?
- How are project/user profile customizations represented relative to an immutable installed `PlaybookVersion`?
- Which non-secret account/provider provenance is sufficient for audit without pinning credentials?
