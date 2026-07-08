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

This spec defines stored run profiles for `feature-development` launch configuration.

It covers:

- default playbook seed/import data;
- Revisium `run_profiles` row shape;
- runtime route resolution;
- Prisma route pins;
- MCP profile discovery.

It does not define:

- profile editing UI;
- remote provider pricing;
- custom user-authored profile mutation tools beyond import/versioning;
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

## Storage Boundary

Revisium engine stores run profiles as versioned meaning. Prisma stores runtime run facts.

Runtime models MUST NOT be represented as Revisium tables. In particular, `TaskRun.routeDecision` in Prisma is the run's
immutable route pin; Revisium `run_profiles` is only the versioned source for new route resolution.

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

Built-in profile ids:

- `claude-standard`;
- `codex-standard`;
- `codex-primary-claude-review-consensus`;
- `claude-primary-codex-review-consensus`.

Consensus profile ids use `<primary-runner>-primary-<review-runner>-review-consensus`; the primary runner handles the
main analysis/development slots, and both providers participate in the review consensus slots.

All bundled profiles are scoped to `pipelineId: "feature-development"`.

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
| `id` | Stable profile id inside one playbook. |
| `pipelineId` | Imported pipeline id the profile belongs to. |
| `schemaVersion` | Must be `run-profile/v1`. |
| `version` | Immutable profile version string. |
| `displayName` | Human-readable label. |
| `summary` | Short description for MCP/UI listing. |
| `topology` | Profile topology overlay. |
| `bindings` | Slot/node/runner launch bindings. |
| `status` | `active` or `deprecated`; import may mark removed built-in rows as `removed`. |

The importer MUST reject duplicate profile ids and profiles referencing unknown pipeline ids.

## Catalog Validation

Catalog import MUST validate stored JSON payloads before writing Revisium rows.

- `catalog/run-profiles.json` records MUST pass the `run-profile/v1` JSON Schema.
- `catalog/pipelines.json[*].execution_policy.template_json`, when present, MUST pass the pipeline template JSON Schema.
- Semantic graph validation, such as unresolved edges or invalid capability references, remains the responsibility of the
  pipeline-core validators.

The Revisium `run_profiles.profile_json` and `pipelines.execution_policy_json` fields are serialized storage fields.
Serialization MUST happen only after AJV validation succeeds. A failed validation aborts import/bootstrap and no invalid
profile or pipeline config should be written as control-plane meaning.

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
| `profile_json` | Normalized full profile JSON. |
| `profile_hash` | Stable content hash of `profile_json`. |
| `status` | `active`, `deprecated`, or import tombstone `removed`. |
| `retired_at` | Import timestamp when a previously seeded row was removed from the catalog. |
| `source_path` | Catalog path, usually `catalog/run-profiles.json`. |
| `source_hash` | Source/content hash. |
| `updated_at` | Import timestamp. |

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

When a profile and caller execution overrides both provide the same role/node binding, later caller-provided overrides
win for the same match. Runner overrides may still map a profile-selected runner to a test/stub runner.

## Runtime Resolution

`simulate_route` and `create_run` resolve routes through the same service path.

If `profileId` is absent:

1. resolve the selected playbook;
2. resolve the selected pipeline;
3. validate the caller execution profile;
4. return/create a route for the imported base template.

If `profileId` is present:

1. resolve the selected playbook;
2. resolve the selected pipeline;
3. resolve `run_profiles` by the same playbook and pipeline;
4. require a matching active `profile_id`;
5. materialize the template from `profile_json.topology`;
6. convert `profile_json.bindings` into execution binding overrides;
7. validate the effective execution profile;
8. return/create a route with profile provenance pins.

The service MUST reject a profile that belongs to another pipeline.
The service MUST reject storage row ids such as `revisium-default-codex-standard` as `profileId`; callers use the
catalog `profile_id` only.

## Route Pins

When a profile is applied, Prisma `TaskRun.routeDecision` MUST include:

- `requestedPipelineId`;
- `basePipelineId`;
- `profileId`;
- `profileVersion`;
- `profileHash`;
- `profileSnapshot`;
- `materializedTemplateHash`;
- `materializedTemplate`;
- `materializerVersion`;
- `policyVersion`;
- resolved role/node launch bindings.

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
- no hardcoded profile registry is used by production route resolution.
