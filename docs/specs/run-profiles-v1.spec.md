# Run profiles v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo runtime, MCP, control plane
- **Source files:** `src/control-plane/run-profiles.ts`, `src/pipeline-core/materialize.ts`,
  `src/pipeline/route-contract.ts`, `src/task-control-plane/task-control-plane-api.service.ts`,
  `src/revisium/playbooks.service.ts`, `src/playbook/**`, `src/mcp/**`,
  `control-plane/default-playbook/catalog/run-profiles.json`
- **Related ADRs:** [ADR-0006](../adr/0006-run-profiles-and-provider-neutral-pipelines.md)
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [default-playbook-policy.spec.md](./default-playbook-policy.spec.md),
  [playbook-storage-v1.spec.md](./playbook-storage-v1.spec.md)

## Scope

This spec defines stored and inline run profiles for launch configuration.

It covers:

- default playbook seed/import data;
- editable profile lifecycle;
- Revisium `run_profiles` row shape;
- runtime route resolution;
- Prisma route pins;
- MCP profile discovery and profile-design capabilities.

It does not define:

- visual profile editing UI layout;
- remote provider pricing;
- GitHub publishing identity selection;
- arbitrary post-join synthesis beyond the current materializer substrate.

## Terms

| Term | Meaning |
| --- | --- |
| Pipeline | Provider-neutral workflow graph such as `feature-development`. |
| RunProfile | Versioned launch configuration for one pipeline. |
| Topology overlay | Profile-owned materialization settings, such as consensus fanout for selected stages. |
| Binding | Runner/model/permission/timeout selection for a role slot, node slot, or future lane. |
| Materialized template | Pipeline template after applying the topology overlay. |
| Route pin | Immutable route decision stored on the Prisma run row. |
| Seeded profile | Profile imported from a playbook catalog during bootstrap/import. After import it is editable profile data. |
| Inline profile | Unsaved `run-profile/v1` payload supplied to route simulation or run creation. |

## Storage Boundary

Revisium engine stores run profiles as versioned meaning. Prisma stores runtime run facts.

Runtime models MUST NOT be represented as Revisium tables. In particular, `TaskRun.routeDecision` in Prisma is the run's
immutable route pin; Revisium `run_profiles` is only the versioned source for new route resolution.

Run profiles MUST NOT carry credentials or publication account aliases in v1. GitHub identity selection remains a
separate host/runtime concern until a dedicated publishing contract is designed.

## Default Catalog

The default playbook manifest may declare:

```json
{
  "catalogs": {
    "roles": "catalog/roles.json",
    "pipelines": "catalog/pipelines.json",
    "runProfiles": "catalog/run-profiles.json"
  }
}
```

The bundled default profile catalog is `control-plane/default-playbook/catalog/run-profiles.json`.

Every launchable pipeline must have at least one seeded or user-created profile before `create_run` enforces the strict
profile contract. The initial `feature-development` seeded profile ids are:

- `claude-standard`;
- `codex-standard`;
- `codex-primary-claude-review-consensus`;
- `claude-primary-codex-review-consensus`.

Consensus profile ids use `<primary-runner>-primary-<review-runner>-review-consensus`; the primary runner handles the
main analysis/development slots, and both providers participate in the review consensus slots.

The initial bundled profiles are scoped to `pipelineId: "feature-development"`. The default playbook must also seed or
otherwise provide profiles for other launchable pipelines, such as `local-change`, before those pipelines require
profile-backed launches.

## Catalog Shape

```json
{
  "id": "codex-standard",
  "pipelineId": "feature-development",
  "schemaVersion": "run-profile/v1",
  "version": "1",
  "displayName": "Codex standard",
  "summary": "Codex for feature-development agent slots.",
  "topology": {
    "stages": {
      "analyst": { "mode": "single" },
      "planReview": { "mode": "single" },
      "developer": { "mode": "single" },
      "codeReview": { "mode": "single" }
    }
  },
  "bindings": {
    "slots": {
      "analyst": { "runnerId": "codex", "modelLevel": "codex-deep", "permissionMode": "workspace-write" },
      "developer": { "runnerId": "codex", "modelLevel": "codex-standard", "permissionMode": "workspace-write" }
    }
  },
  "status": "active"
}
```

Required catalog fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable profile id inside one playbook and pipeline. |
| `pipelineId` | Imported pipeline id the profile belongs to. |
| `schemaVersion` | Must be `run-profile/v1`. |
| `version` | Immutable profile version string. |
| `displayName` | Human-readable label. |
| `summary` | Short description for MCP/UI listing. |
| `topology` | Profile topology overlay. |
| `bindings` | Slot/node/runner launch bindings. |
| `status` | `active` or `deprecated`; import may mark unchanged removed seeded rows as `removed`. |

The importer MUST reject duplicate profile ids and profiles referencing unknown pipeline ids.

`publishing` is not part of the current `run-profile/v1` catalog shape. Importers MUST reject it as an additional
property until a separate publishing identity contract exists.

Stored catalog rows MUST include `id`, `pipelineId`, and `version` as catalog/storage metadata. Inline
`create_run.profile` and `simulate_route.profile` inputs MUST NOT include persisted identity, pipeline, display, or
lifecycle fields; the launch request's top-level `pipelineId` is the only pipeline selector.

## Catalog Validation

Catalog import MUST validate stored JSON payloads before writing Revisium rows.

- `catalog/run-profiles.json` records MUST pass the `run-profile/v1` JSON Schema.
- `catalog/pipelines.json[*].execution_policy.template_json`, when present, MUST pass the pipeline template JSON Schema.
- Semantic graph validation, such as unresolved edges or invalid capability references, remains the responsibility of the
  pipeline-core validators.

The Revisium `run_profiles.profile_json` field stores only the launch payload: `schemaVersion`, `topology`, and
`bindings`. Catalog/storage metadata lives in row columns such as `pipeline_id`, `profile_id`, `version`,
`display_name`, and `status`. Serialization MUST happen only after AJV validation succeeds. A failed validation aborts
import/bootstrap and no invalid profile or pipeline config should be written as control-plane meaning.

## Revisium Row Shape

Imported rows are written to the `run_profiles` table.

Fields:

| Field | Meaning |
| --- | --- |
| `id` | Internal scoped row id, e.g. `revisium-default-codex-standard`; not a public launch alias. |
| `playbook_id` | Installed playbook id. |
| `pipeline_id` | Profile pipeline id. |
| `profile_id` | Catalog profile id. |
| `schema_version` | Run profile schema version. |
| `version` | Immutable profile version. |
| `display_name` | Listing label. |
| `summary` | Listing summary. |
| `profile_json` | Normalized launch payload JSON. |
| `profile_hash` | Stable launch hash of `profile_json` plus selected/storage pipeline context. |
| `status` | `active`, `deprecated`, or import tombstone `removed`. |
| `retired_at` | Import timestamp when a previously seeded row was removed from the catalog. |
| `source_path` | Catalog path, usually `catalog/run-profiles.json`. |
| `source_hash` | Last applied normalized catalog profile hash, when the row came from catalog import. |
| `updated_at` | Import timestamp. |

Seeded profiles are normal editable rows after import. Profile updates SHOULD keep the internal row id stable and write
a new Revisium revision with a new `version`, `profile_json`, and `profile_hash`. Old runs do not depend on the current
row because they carry Prisma route pins.

Catalog reconciliation MUST NOT silently overwrite edits. A seeded row is catalog-clean only when its current
`profile_hash` still matches the last applied normalized catalog profile hash stored in `source_hash`. Import may update
or retire catalog-clean rows. If the row changed after import, reconciliation preserves the row and reports a catalog
update or removal conflict instead of replacing it.

### Profile Hashes

`profile_hash` and `source_hash` use the same canonical profile normalization:

- include launch-affecting fields: selected/storage `pipelineId`, `schemaVersion`, `topology`, `bindings`, and any
  future launch policy fields;
- exclude row metadata and lifecycle/provenance fields: `displayName`, `summary`, `status`, `source_path`,
  `source_hash`, `retired_at`, `updated_at`, clone provenance, and authorship fields;
- normalize object key order and omit undefined values before hashing.

Display-only metadata changes write a Revisium revision but do not change the launch payload hash. Route pins use the
launch payload hash because that is the replay identity.

## Topology V1

The current v1 materializer supports consensus overlays for existing agent stages.

Supported stage modes:

- `single`: no graph change;
- `consensus`: materializes deterministic fanout plus join for a target stage.

Current default stage keys:

| Stage key | Base target node | Materialized base name |
| --- | --- | --- |
| `planReviewer` | `planReviewer` | `planReview` |
| `codeReview` | `codeReview` | `codeReview` |

The materializer emits deterministic node ids such as `planReviewFanout`, `planReviewPrimary`,
`planReviewSecondary`, and `planReviewJoin`.

## Binding V1

Bindings are stored in `bindings.slots`.

Slot key rules:

- `role:<id>` targets a role binding;
- `node:<id>` targets a materialized or base node;
- known semantic role slots such as `analyst`, `developer`, `triager`, and `watcher` target role bindings;
- any other key targets a node id.

Binding fields:

| Field | Meaning |
| --- | --- |
| `runnerId` | Concrete runner id such as `codex` or `claude-code`. |
| `modelLevel` | Model level such as `standard`, `deep`, `codex-standard`, or `codex-deep`. |
| `permissionMode` | Runner permission mode. |
| `timeoutMs` | Positive timeout override. |

Profile bindings are the public launch binding source. Internal test harnesses may map a profile-selected runner to a
test/stub runner, but that mapping is not a second user-facing profile layer.

## Profile Lifecycle

All profiles are stored in the same `run_profiles` table and use the same `run-profile/v1` payload shape. Seeded profiles
are editable; cloning is optional convenience, not a permission boundary.

Required operations:

| Operation | Meaning |
| --- | --- |
| `get_profile` | Read one profile by playbook, pipeline, and public `profile_id`. |
| `validate_profile` | Validate a stored, cloned, or inline profile without committing it. |
| `clone_profile` | Copy any stored profile under a new `profile_id`. |
| `create_profile` | Create a new stored profile. |
| `update_profile` | Commit a new version/hash for an existing profile. |
| `deprecate_profile` | Mark a profile `deprecated` so new launches do not use it by default. |

Mutation rules:

- seeded rows MUST allow `update_profile` and `deprecate_profile`;
- `create_profile` and `clone_profile` MUST reject duplicate `profile_id` values in the same playbook and pipeline;
- `clone_profile` MUST record clone provenance, including source profile id, version, and hash;
- `update_profile` MUST require a base version or profile hash precondition and reject stale updates;
- `update_profile` MUST write a new Revisium revision and a new `profile_hash`;
- `profile_id` is stable for callers and points to the latest active version;
- `deprecated` profiles are listed only when `includeDeprecated=true` and MUST be rejected for new launches in v1;
- existing runs remain replayable from their Prisma route pin, not from the latest profile row;
- playbook catalog reconciliation MUST preserve edited profiles and may update or retire only catalog-clean seeded rows;
- profile mutation MUST reject unknown pipeline ids, unknown topology stages, unknown slots, unsupported runners, invalid
  model levels, invalid permission modes, invalid timeouts, and unsupported additional properties.

## Profile Designer Discovery

Profile editors and agents MUST NOT guess the editable surface from raw JSON alone. The control-plane API should expose
a pipeline-scoped discovery document.

Required discovery fields:

| Field | Meaning |
| --- | --- |
| `playbookId` | Effective playbook. |
| `pipelineId` | Target pipeline. |
| `profileSchemaVersion` | Current accepted run profile schema version. |
| `topologyStages` | Stage keys, supported modes, and fanout bounds. |
| `bindingSlots` | Role/node/semantic slots that may be bound. |
| `runners` | Supported runner ids and capabilities. |
| `modelLevels` | Model levels valid for each runner or globally. |
| `permissionModes` | Permission modes valid for each runner. |
| `suggestions` | Suggested profile ids or templates for authoring only. |

The discovery document is advisory UI/API metadata. The server remains authoritative and MUST re-run validation during
profile create/update, route simulation, and run creation. Discovery suggestions MUST NOT fill missing runner/model
launch values during route resolution; route resolution consumes a normalized profile.

## Deferred Publishing Identity

GitHub publishing identity is not part of `run-profile/v1`. The schema MUST reject `publishing` fields in stored and
inline profiles so account aliases cannot become dead launch data.

A future publishing contract must define account-selection precedence, token lookup, failure behavior, and route
provenance before profile JSON accepts GitHub account preferences. Until then, publication paths use the existing host
authentication behavior and profiles do not influence the GitHub account.

## Runtime Resolution

`simulate_route` and `create_run` resolve routes through the same service path.

The public `create_run` and `simulate_route` launch contract requires `pipelineId` and exactly one of `profileId` or
inline `profile`. The pipeline does not contain runner/model defaults.

If `profileId` is present:

1. resolve the selected playbook;
2. resolve the selected pipeline;
3. resolve `run_profiles` by the same playbook and pipeline;
4. require a matching active `profile_id`;
5. materialize the template from `profile_json.topology`;
6. convert `profile_json.bindings` into launch bindings;
7. validate the effective launch profile against the selected pipeline;
8. return/create a route with profile provenance pins.

If inline `profile` is present:

1. require that `profileId` is absent;
2. validate the inline profile against `run-profile/v1`;
3. reject persisted identity, pipeline, display, lifecycle, and unknown fields in the inline body;
4. run the same semantic validation as for a stored profile in the selected pipeline context;
5. materialize topology and bindings from the inline profile;
6. compute a stable inline profile hash using the selected pipeline as hash context;
7. return/create a route with profile provenance pins.

The service MUST reject storage row ids such as `revisium-default-codex-standard` as `profileId`; callers use the
catalog `profile_id` only.

Inline `profile` is not persisted to `run_profiles`, is not returned by `list_profiles`, and has no Revisium row id.
Internal test harnesses may still map runner implementations outside the public API, but those mappings must not be
modeled as a second user-facing profile object.

MCP inputs, GraphQL inputs, route resolution, and Prisma `TaskRun` storage MUST NOT expose a second profile-like launch
object. New runs store every replay-needed launch field in `routeDecision`.

## Route Pins

Prisma `TaskRun.routeDecision` MUST include route provenance for all launches. This snapshot is the execution source of
truth for the run, even when the run was created from `profileId`.

- `requestedPipelineId`;
- `basePipelineId`;
- `profileSource`, one of `stored` or `inline`;
- `materializedTemplateHash`;
- `materializedTemplate`;
- `materializerVersion`;
- `policyVersion`;
- resolved role/node launch bindings.

Future route pins may add resolved publishing identity and resolved model-profile provenance once those contracts are
versioned and implemented.

For `profileSource=stored`, the route pin MUST also include `profileId`, `profileVersion`, `profileHash`, and
`profileSnapshot`.

For `profileSource=inline`, the route pin MUST include `profileHash` and `profileSnapshot`. Stored-profile identity
fields (`profileId`, `profileVersion`) SHOULD be omitted or null for inline launches. The inline profile hash is the
replay identity.

`routeDecision.source` remains the route-selection source, such as explicit or inferred pipeline selection. It is
distinct from `profileSource`, which records whether the launch configuration came from stored control-plane profile data
or an inline request body.

Replay, resume, digest, and workflow inspection MUST read the pinned route decision. They MUST NOT re-read the latest
Revisium profile row for an existing run.

## MCP Surface

`list_profiles` returns storage-backed profiles. Inputs:

| Field | Meaning |
| --- | --- |
| `playbookId` | Optional playbook id. Defaults to the resolved default playbook. |
| `pipelineId` | Optional pipeline id filter. |
| `includeDeprecated` | Include deprecated profiles when true. |
| `includeDetails` | Include full `profile_json` when true. |

`create_run.profileId` and `simulate_route.profileId` reference the catalog `profile_id` values returned by
`list_profiles`, not the internal Revisium row ids.

`create_run.profile` and `simulate_route.profile` accept a complete unsaved launch profile payload. `profileId` and
`profile` are mutually exclusive. Public launches require exactly one of them.

Profile-management tools should expose:

| Tool | Mutates Storage | Meaning |
| --- | --- | --- |
| `describe_profile_capabilities` | no | Return the pipeline-scoped discovery document. |
| `get_profile` | no | Return one stored profile with normalized JSON and provenance. |
| `validate_profile` | no | Validate an inline or edited profile without committing. |
| `clone_profile` | yes | Copy any stored profile under a new profile id. |
| `create_profile` | yes | Create a new profile. |
| `update_profile` | yes | Commit a new version/hash for an existing profile. |
| `deprecate_profile` | yes | Mark a profile deprecated. |

`get_capabilities` SHOULD advertise `list_profiles` as the discovery path. It MUST NOT advertise TypeScript constants as
authoritative profile ids.

## Validation

Required automated coverage:

- default playbook import writes `run_profiles` rows;
- default playbook exposes `feature-development` and `local-change` as pipelines, with consensus represented as profiles;
- importer rejects invalid run profile JSON Schema payloads and invalid pipeline `template_json` shape;
- importer rejects duplicate profile ids and unknown pipeline references;
- `list_profiles` reads storage and filters by playbook/pipeline;
- route simulation with `profileId` materializes graph and stamps provenance;
- create/start/resume/get workflow use pinned Prisma route decisions;
- no hardcoded profile registry is used by production route resolution;
- seeded profiles are editable and update_profile writes new Revisium revisions;
- playbook re-import preserves edited profiles and updates/retires only catalog-clean seeded profiles;
- update_profile rejects stale base version/hash preconditions;
- deprecated profiles are listed only when requested and are rejected for new v1 launches;
- `describe_profile_capabilities` exposes editable topology stages, binding slots, and runner/model/permission choices;
- inline `profile` validates and materializes without writing `run_profiles`;
- inline route pins use `profileSource=inline`, carry a profile hash/snapshot, and do not require a Revisium row id;
- create_run and simulate_route require exactly one of `profileId` or inline `profile`;
- default playbook provides profiles for every pipeline that remains launchable under the strict profile contract;
- no separate profile-like launch object is exposed by MCP inputs, GraphQL inputs, route resolution, or Prisma
  `TaskRun` storage;
- `publishing` fields are rejected in stored and inline `run-profile/v1` payloads until a dedicated publishing identity
  contract exists;
- GitHub tokens are never stored in `profile_json`, inline `profile`, or `routeDecision`.
