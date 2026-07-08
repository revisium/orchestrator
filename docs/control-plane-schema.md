# Control-plane schema

The control plane has two storage classes:

- Revisium engine stores versioned meaning: playbooks, roles, pipelines, model profiles, run profiles, and routing
  policy.
- Revo Prisma stores runtime facts: projects, runs, tasks, events, attempts, inbox, outputs, and cost ledger.

`control-plane/bootstrap.config.json` is the human-authored bootstrap source for Revisium meaning tables. Prisma schema
and migrations are the authoritative source for runtime tables.

## Ownership Classes

| Storage | Table/model | Class | Revision behavior |
| --- | --- | --- | --- |
| Revisium | `playbooks` | Versioned meaning | committed; route/import reads head |
| Revisium | `roles` | Versioned meaning | committed; execution reads head |
| Revisium | `pipelines` | Versioned meaning | committed; run start reads and pins template meaning |
| Revisium | `run_profiles` | Versioned meaning | committed; launch resolves profile data by playbook + pipeline |
| Revisium | `model_profiles` | Versioned meaning | committed; execution reads head |
| Revisium | `routing_policy` | Versioned meaning | committed; route policy reads head |
| Prisma | `RevoProject` | Product state | soft-deleted project grouping and repository metadata |
| Prisma | `TaskRun` | Runtime run | transactional runtime row; stores route pins |
| Prisma | `RunTask` | Runtime task | transactional runtime row |
| Prisma | `RunEvent` | Runtime journal | append-only runtime event |
| Prisma | `RunAttempt` | Runtime provenance | per-attempt logs/cost/provenance |
| Prisma | `InboxItem` | Runtime human queue | pending/resolved human decisions |
| Prisma | `RunOutput` | Runtime dataflow artifact | node output and artifact pointers |
| Prisma | `CostLedgerEntry` | Runtime accounting | token/cost ledger |

DBOS owns workflow progress and replay. Prisma runtime rows are Revo's product/runtime state around that workflow.
Revisium rows are never the authoritative store for run lifecycle facts.

## Revisium Schema Rules

- Row identity is the Revisium row id. Explicit `id` fields are readability mirrors.
- Versioned meaning edits require a commit.
- Free-form JSON is stored in serialized string fields where the Revisium schema layer requires it.
- Serialized JSON fields that carry structured control-plane config must be AJV-validated before import/write. The
  Revisium table schema protects storage shape; the importer protects nested JSON semantics.
- Bootstrap seed rows validate `roles.scope_rules`, `model_profiles.params`, and `routing_policy.rule` before they are
  written.
- Product services should use domain APIs, not raw transport table reads.

## Revisium Meaning Tables

### `playbooks`

Installed playbook metadata.

Fields: `id, name, package_name, source, version, schema_version, manifest_path, roles_catalog_path,
pipelines_catalog_path, run_profiles_catalog_path, catalog_hash, installed_at, updated_at`.

### `roles`

Versioned role definitions.

Fields: `id, name, system_prompt, model_level, effort, runner_id, runner, allowed_tools[], scope_rules,
timeout_ms, permission_mode, playbook_id, playbook_role_id, source_path, source_hash, surface, rights, status,
retired_at, updated_at`.

`scope_rules` is serialized JSON. `runner_id` is the preferred imported playbook field; `runner` remains a readability
mirror while role imports settle.

### `pipelines`

Imported pipeline definitions.

Fields: `id, playbook_id, pipeline_id, path, triggers[], required_roles[], alternative_roles_json,
optional_roles[], route_gates[], platform_invocation, execution_policy_json, status, retired_at, updated_at`.

`execution_policy_json` carries the data-driven pipeline template. The base pipeline owns workflow semantics only.
Provider/model/topology launch choices belong to `run_profiles`.
When imported from a playbook catalog, `execution_policy.template_json` must pass JSON Schema validation before it is
serialized into this field.

### `run_profiles`

Versioned launch profiles scoped to an imported playbook and pipeline.

Fields: `id, playbook_id, pipeline_id, profile_id, schema_version, version, display_name, summary, profile_json,
profile_hash, status, retired_at, source_path, source_hash, updated_at`.

`profile_json` stores the normalized launch payload: `schemaVersion`, `topology`, and `bindings`. Profile scope and
lifecycle metadata live in row columns such as `pipeline_id`, `profile_id`, `version`, and `status`. `profile_hash` is
pinned into Prisma `TaskRun.routeDecision` when a run is created. Catalog run profiles must pass the `run-profile/v1`
JSON Schema before they are serialized into `profile_json`. Seeded profiles are editable after import; profile updates
write a new Revisium revision and a new `profile_hash`.

`source_path` and `source_hash` record the last applied catalog source when a row came from default playbook import.
`source_hash` is the last applied normalized catalog profile hash, computed with the same normalization as
`profile_hash`. The normalized launch hash includes launch-affecting fields such as selected/storage pipeline id,
topology, bindings, and future launch policy fields; it excludes display/lifecycle/provenance row metadata. Catalog
reconciliation must not
silently overwrite edits: import may update or retire only rows whose current `profile_hash` still matches
`source_hash`. Edited rows are preserved and reported as catalog update or removal conflicts.

The public pipeline/profile identifiers are `pipeline_id` and `profile_id`. The storage row `id` is an internal scoped
row id and is not accepted as a launch alias. When a catalog removes a profile, import may mark unchanged seeded rows
`status=removed`; runtime listing/resolution ignores removed rows.

Publishing identity is intentionally outside the current `run-profile/v1` shape. Future GitHub account selection must
be added as a separate validated launch/config contract before it is accepted in `profile_json`.

### `model_profiles`

Versioned model-level mapping.

Fields: `id, level, provider, model_id, params, cost_per_input, cost_per_output, updated_at`.

Route and role data reference levels such as `cheap`, `standard`, `deep`, `codex-standard`, and `codex-deep`, not raw
provider model ids.

### `routing_policy`

Versioned routing policy.

Fields: `id, rule, model_level, requires_human, updated_at`.

## Prisma Runtime Models

### `TaskRun`

Runtime run record.

Important fields: `id, projectId, title, description, status, repos, scope, priority, playbookId, pipelineId, params,
routeDecision, createdBy, createdAt, updatedAt`.

`routeDecision` pins `requestedPipelineId`, `basePipelineId`, `profileSource`, `profileHash`, `profileSnapshot`,
`materializedTemplateHash`, `materializedTemplate`, `materializerVersion`, `policyVersion`, and resolved launch
bindings. Stored-profile launches also pin `profileId` and `profileVersion`; inline-profile launches omit or null
stored-profile identity fields and use `profileHash` as replay identity. Public launches are created from either a
stored `profileId` or an inline profile body, and Prisma stores the resolved normalized profile snapshot in both cases.
Replay uses this pin, not the latest Revisium profile row.

Launch configuration is stored in `routeDecision.profileSnapshot` and resolved launch bindings. There is no separate
Prisma column for profile-like launch overrides. Future route pins may add model-profile provenance once model profile
resolution becomes a versioned runtime contract.

`routeDecision.profileSnapshot` stores the normalized launch payload, not the selected pipeline id. The selected pipeline
is pinned separately as `requestedPipelineId` and `basePipelineId`.

`params.issueRef` is the canonical issue traceability location for issue-bound runs. Shape:
`{ repo: string, number: positive integer, url: string }`. `params.issueAction` controls delivery linkage and is one of
`close`, `refs`, or `none`.

### Runtime Child Models

- `RunTask`: task rows under a run.
- `RunEvent`: append-only runtime journal with a monotonic `sequence` for deterministic ordering. Payloads must be secret-redacted before write.
- `RunAttempt`: per-attempt provenance for logs, verdict assertions, decimal cost amounts, and summaries.
- `InboxItem`: human approval/question/alert queue.
- `RunOutput`: node output and artifact pointers. Large content should use `payloadRef`.
- `CostLedgerEntry`: token and decimal cost accounting.
