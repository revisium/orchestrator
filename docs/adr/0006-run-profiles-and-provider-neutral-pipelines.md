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

The seeded profile set is not enough for product use. Users need to create, edit, validate, and simulate profiles
without editing TypeScript constants or changing the default playbook catalog. They also need to control which GitHub
account performs publication. That account is launch configuration, but credentials are runtime host secrets and must
not be stored in profile data.

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
- profile version metadata, launch hash, status, source path, and provenance.

The base pipeline owns workflow semantics: nodes, edges, gates, slot names, and allowed materialization points. It does
not encode concrete provider identities by duplicating the graph.

### Storage

Stored run profiles are imported into Revisium `run_profiles` rows alongside the default playbook data.

Default profiles are seeded from `control-plane/default-playbook/catalog/run-profiles.json`. Every launchable pipeline
must have at least one seeded or user-created profile before the strict launch contract is enforced. The initial
feature-development seeded profile set is:

- `claude-standard`;
- `codex-standard`;
- `codex-primary-claude-review-consensus`;
- `claude-primary-codex-review-consensus`.

Consensus profile ids use `<primary-runner>-primary-<review-runner>-review-consensus` so the first provider is the
primary analysis/development runner and the second provider participates in review consensus.

Runtime code may contain schema, validation, import, and materialization logic, but not the authoritative default profile
data itself.

Playbook import validates catalog-owned structured JSON with AJV before writing Revisium rows. In particular,
`run-profile/v1` records and pipeline `execution_policy.template_json` must pass JSON Schema validation before they are
serialized into `run_profiles.profile_json` or `pipelines.execution_policy_json`.

The public identifiers are the catalog `pipeline_id` and `profile_id`. Revisium row ids such as
`revisium-default-19-feature-development-codex-standard` are internal storage ids and are not accepted as alternate launch ids.

### Editable Profiles

Seeded and user-authored profiles use the same `run_profiles` table and the same `run-profile/v1` schema. After import,
seeded rows are ordinary editable profiles.

Profile updates mutate the current stored profile row and commit a new Revisium revision. `profile_id` remains the
stable public handle inside a playbook/pipeline. A launch-affecting edit changes `profile_hash`; a metadata-only edit
may keep the same `profile_hash` but changes `profile_revision_hash`. Callers must send
`expectedProfileRevisionHash` as an optimistic lock so stale edits cannot silently overwrite newer launch data, display
metadata, or lifecycle status. Existing runs remain replayable through the Prisma route snapshot, not through the current
Revisium row. Any user mutation, including display-only edits and deprecation, must invalidate catalog-clean provenance
so catalog re-import cannot silently restore the seeded row state.

Profile mutation APIs must validate both JSON shape and semantic compatibility before committing a revision:

- the selected pipeline exists in the same playbook;
- `profile_id` is unique inside the same playbook and pipeline;
- topology stages are known materialization points for that pipeline;
- binding slots resolve to allowed role/node slots;
- runner ids, model levels, permission modes, and timeouts are valid for the target runner;
- the payload contains only fields supported by the current `run-profile/v1` schema.

Playbook catalog reconciliation must not silently overwrite operator edits. Import may create missing seeded profiles and
may update a previously seeded profile only when its current profile hash still matches the last applied normalized
catalog profile hash. If the row was edited after seeding, import preserves the edited profile and should report that a
catalog update is available or conflicted. If a later catalog removes a profile, import may mark only unchanged
catalog-seeded rows as `removed`; customized rows remain launchable until a user explicitly changes their status.

### Inline Profiles

`RunProfile` is the only public launch configuration shape. MCP/GraphQL inputs, runtime route resolution, and Prisma
`TaskRun` storage must not expose a second profile-like launch object. Test runner adapters must be represented outside
the public launch contract and must not create a second object that competes with `RunProfile`.

For one-off design and experimentation, `simulate_route` and `create_run` accept an inline `profile`: an unsaved profile
launch payload with the same topology and binding shape as stored profiles. Stored profiles have persistent
`profile_id`, `pipeline_id`, and `version` metadata; inline payloads must omit those storage fields and use the launch
request's top-level `pipelineId` as the selected pipeline context. The inline profile is validated through the same
semantic checks as a stored profile, materialized the same way, and pinned into Prisma route provenance with its
hash/snapshot. It is not written to `run_profiles` and does not appear in `list_profiles`.

Stored `profileId` and inline `profile` are mutually exclusive in one launch request.

### Publishing Identity

Publishing identity is deliberately out of scope for the current `run-profile/v1` implementation. The profile schema
rejects `publishing` fields so account selection cannot be hashed or pinned without runtime support.

A later ADR/spec must define GitHub account selection, token lookup, host/project precedence, and route provenance before
profile JSON accepts publishing preferences. Until then, write-capable GitHub behavior must use the existing host auth
path and must not treat run profiles as the source of publishing identity.

### Runtime Resolution

`list_profiles({ pipelineId })` reads Revisium control-plane storage and filters by playbook/pipeline. It does not import
hardcoded arrays.

`create_run` and `simulate_route` resolve the selected pipeline from Revisium storage. The public launch contract
requires the caller to supply `pipelineId` plus exactly one of `profileId` or inline `profile`; the pipeline itself does
not provide runner/model defaults. If `profileId` is supplied, they:

1. resolve the stored profile row for the same playbook and pipeline;
2. convert the profile topology overlay into a materialized template;
3. convert profile bindings into launch bindings;
4. validate the effective launch profile against the selected pipeline;
5. pin profile id/version metadata, profile hash/snapshot, and materialized template hash into the Prisma
   `TaskRun.routeDecision`.

If inline `profile` is supplied, the same validation and materialization path runs over the provided body, and
`TaskRun.routeDecision` stores the normalized profile snapshot and hash for execution and replay.

### Replay And Provenance

Run execution, replay, and resume use the pinned Prisma route decision. They do not re-read the latest Revisium profile
row and do not re-materialize unless an explicit future command creates a new run or route decision.

The pinned route decision records:

- requested and base pipeline ids;
- profile source, such as stored or inline;
- profile id and version when the profile came from storage;
- profile hash and normalized profile snapshot for every run;
- selected pipeline id as separate requested/base pipeline provenance;
- materialized template hash and materializer version;
- policy version;
- resolved role/node launch bindings.

Future route pins may add resolved publishing identity and model-profile provenance once those contracts are explicitly
designed and implemented.

## Alternatives

- **Keep provider variants as pipeline ids.** Rejected. It duplicates workflow policy and makes route behavior drift.
- **Keep profiles in TypeScript constants.** Rejected. It makes seeded defaults invisible to control-plane
  import/versioning and prevents operator discovery through MCP.
- **Expose two public launch configuration objects.** Rejected. It creates competing sources for runner/model/binding
  selection. Public launches use a stored profile or an inline profile body only.
- **Store runtime run state in Revisium.** Rejected. Runtime state is Prisma-owned; Revisium engine is reserved for
  versioned meaning/config.
- **Store only `profileId` in the run.** Rejected. Replay would change when a profile row changes.
- **Default GitHub publication to a hardcoded org account.** Rejected. Local Revo runs must use the active host
  authentication path until a dedicated publishing identity contract exists.
- **Store GitHub tokens in profiles.** Rejected. Profiles are versioned meaning and may be listed through control-plane
  APIs; tokens are host-local secrets.

## Consequences

- The default playbook imports `run_profiles` together with playbooks, roles, and pipelines.
- MCP advertises `list_profiles` and profile-aware route simulation.
- MCP/GraphQL expose profile validation and mutation tools before a UI edits profiles directly.
- Existing run/profile logic is centered on storage-backed profile rows.
- Tests must assert that default profiles are seeded catalog data and that route decisions pin profile provenance.
- GitHub publication identity remains outside `run-profile/v1` until a dedicated provenance contract is designed.

## Validation

Implementation PRs should verify:

- default playbook import writes `run_profiles` rows for each launchable seeded pipeline;
- invalid run profile JSON Schema payloads and invalid pipeline template shapes fail during import before Revisium write;
- `list_profiles` returns storage-backed profiles by selected playbook/pipeline;
- `simulate_route` and `create_run` with `profileId` materialize the graph and stamp route provenance;
- replay/resume uses the pinned Prisma route decision without re-resolving the latest profile row;
- no provider-specific feature-development pipeline id or TypeScript profile registry remains;
- seeded profiles are editable through profile mutation APIs;
- inline `profile` validates/materializes/pins without being listed as a stored profile;
- `create_profile` and `update_profile` validate profile payloads against the selected pipeline before writing storage;
- `update_profile` requires `expectedProfileRevisionHash` and mutates the current profile row through a new Revisium revision;
- catalog re-import preserves edited profiles and only updates or retires unchanged catalog-seeded rows;
- write-capable GitHub behavior uses the existing host auth path; profiles reject publishing fields and are not a source
  of publishing identity in `run-profile/v1`.
