# ADR-0006 - Run profiles and provider-neutral feature-development

- **Status:** Draft
- **Decision date:** 2026-07-03
- **Specs:** [run profiles v1](../specs/run-profiles-v1.spec.md)
- **Relates-to:** [pipeline state machine v1](../specs/pipeline-state-machine-v1.spec.md),
  [default playbook policy](../specs/default-playbook-policy.spec.md),
  [runner capabilities v1](../specs/runner-capabilities-v1.spec.md),
  [playbook storage v1](../specs/playbook-storage-v1.spec.md)

## Context

The default feature-development workflow must support different runner/model mixes without duplicating the pipeline
graph. Pipeline variants that encode provider choices drift quickly: every recovery path, gate, cleanup step, and policy
rule has to be kept in sync by hand.

The storage boundary is now explicit:

- Revisium engine stores versioned meaning and static configuration.
- Revo Prisma stores runtime facts and mutable run state.
- DBOS owns workflow execution/replay progress.

Run profiles belong to Revisium meaning because they are versioned launch configuration. Run instances, route decisions,
events, attempts, inbox items, outputs, and costs belong to Prisma.

## Decision

Adopt `RunProfile` as first-class control-plane data for launch configuration.

### Pipeline Identity

- `feature-development` is the canonical default feature-development pipeline id.
- Provider or topology variants are not public pipeline ids.
- The default playbook imports `feature-development` from `control-plane/default-playbook/catalog/pipelines.json`.
- Runtime code must not contain an authoritative TypeScript profile registry or provider-specific pipeline alias table.

### Run Profile Ownership

A run profile owns launch configuration:

- `pipelineId`;
- topology overlay, such as single-stage or consensus fanout for semantic stages;
- slot/node/runner bindings for runner id, model level, permission mode, timeout, and future budget fields;
- version, hash, status, source path, and provenance.

The base pipeline owns workflow semantics: nodes, edges, gates, slot names, and allowed materialization points. It does
not encode concrete provider identities by duplicating the graph.

### Storage

Stored run profiles are imported into Revisium `run_profiles` rows alongside the default playbook data.

Built-in feature-development profiles are seeded from `control-plane/default-playbook/catalog/run-profiles.json`:

- `claude-standard`;
- `codex-standard`;
- `codex-primary-claude-review-consensus`;
- `claude-primary-codex-review-consensus`.

Consensus profile ids use `<primary-runner>-primary-<review-runner>-review-consensus` so the first provider is the
primary analysis/development runner and the second provider participates in review consensus.

Changing a built-in profile means changing the catalog data and importing a new version/hash. Runtime code may contain
schema, validation, import, and materialization logic, but not the authoritative profile data itself.

Playbook import validates catalog-owned structured JSON with AJV before writing Revisium rows. In particular,
`run-profile/v1` records and pipeline `execution_policy.template_json` must pass JSON Schema validation before they are
serialized into `run_profiles.profile_json` or `pipelines.execution_policy_json`.

The public identifiers are the catalog `pipeline_id` and `profile_id`. Revisium row ids such as
`revisium-default-codex-standard` are internal storage ids and are not accepted as alternate launch ids. When a later built-in
catalog removes a row, import marks the old row `status=removed`; runtime list/resolve paths ignore removed rows.

### Runtime Resolution

`list_profiles({ pipelineId })` reads Revisium control-plane storage and filters by playbook/pipeline. It does not import
hardcoded arrays.

`create_run` and `simulate_route` resolve the selected pipeline from Revisium storage. If `profileId` is supplied, they:

1. resolve the stored profile row for the same playbook and pipeline;
2. convert the profile topology overlay into a materialized template;
3. convert profile bindings into launch overrides;
4. validate the effective execution profile;
5. pin profile/version/hash/snapshot and materialized template hash into the Prisma `TaskRun.routeDecision`.

If no profile is supplied, the base pipeline runs as imported.

### Replay And Provenance

Run replay and resume use the pinned Prisma route decision. They do not re-read the latest Revisium profile row and do
not re-materialize unless an explicit future command creates a new run or route decision.

The pinned route decision records:

- requested and base pipeline ids;
- profile id, version, hash, and normalized profile snapshot when a profile was used;
- materialized template hash and materializer version;
- policy version;
- resolved role/node launch bindings.

## Alternatives

- **Keep provider variants as pipeline ids.** Rejected. It duplicates workflow policy and makes route behavior drift.
- **Keep profiles in TypeScript constants.** Rejected. It makes built-ins invisible to control-plane import/versioning and
  prevents operator discovery through MCP.
- **Store runtime run state in Revisium.** Rejected. Runtime state is Prisma-owned; Revisium engine is reserved for
  versioned meaning/config.
- **Store only `profileId` in the run.** Rejected. Replay would change when a profile row changes.

## Consequences

- The default playbook imports `run_profiles` together with playbooks, roles, and pipelines.
- MCP advertises `list_profiles` and profile-aware route simulation.
- Existing run/profile logic is centered on storage-backed profile rows.
- Tests must assert that built-in profiles are catalog data and that route decisions pin profile provenance.

## Validation

Implementation PRs should verify:

- default playbook import writes four `run_profiles` rows;
- invalid run profile JSON Schema payloads and invalid pipeline template shapes fail during import before Revisium write;
- `list_profiles` returns storage-backed profiles by selected playbook/pipeline;
- `simulate_route` and `create_run` with `profileId` materialize the graph and stamp route provenance;
- replay/resume uses the pinned Prisma route decision without re-resolving the latest profile row;
- no provider-specific feature-development pipeline id or TypeScript profile registry remains.
