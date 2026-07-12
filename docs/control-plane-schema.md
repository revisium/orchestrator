# Control-plane schema

This page describes **Current shipped behavior**. Revo has three durable ownership planes plus source/artifact
storage:

- DBOS owns workflow progress, waits, retries, queues, checkpoints, and replay.
- Revo Prisma owns hot product/runtime facts: projects, runs, tasks, events, attempts, inbox, outputs, cost ledger,
  route pins, and indexes.
- The embedded Revisium engine owns committed/versioned meaning: installed playbook metadata, roles, pipelines, model
  profiles, run profiles, and routing policy.
- Git, worktrees, and files own repository state, source changes, diffs, logs, and large artifacts.

`control-plane/bootstrap.config.json` is the human-authored bootstrap source for Revisium meaning tables. Prisma schema
and migrations are the authoritative source for Revo runtime tables and engine-required physical tables. The engine
tables share the Revo product database, while DBOS uses its own logical database and migration owner.

## Ownership Classes

| Storage | Table/model | Class | Revision behavior |
| --- | --- | --- | --- |
| Revisium | `playbooks` | Installed playbook metadata | committed; route/import reads head |
| Revisium | `roles` | Versioned meaning | committed; execution reads head |
| Revisium | `pipelines` | Versioned meaning and current built-in graph | committed; run start reads and pins materialized template meaning |
| Revisium | `run_profiles` | Versioned meaning | committed; launch resolves profile data by playbook + pipeline |
| Revisium | `model_profiles` | Versioned meaning | committed; execution reads head |
| Revisium | `routing_policy` | Versioned meaning | committed; route policy reads head |
| Prisma | `RevoProject` | Product state | soft-deleted project grouping; no first-class `Repository` model is shipped |
| Prisma | `TaskRun` | Runtime run | transactional runtime row; stores route pins |
| Prisma | `RunTask` | Runtime task | transactional runtime row |
| Prisma | `RunEvent` | Runtime journal | append-only runtime event |
| Prisma | `RunAttempt` | Runtime provenance | per-attempt logs/cost/provenance |
| Prisma | `InboxItem` | Runtime human queue | pending/resolved human decisions |
| Prisma | `RunOutput` | Runtime dataflow artifact | node output and artifact pointers |
| Prisma | `CostLedgerEntry` | Runtime accounting | token/cost ledger |

DBOS owns workflow progress and replay. Prisma runtime rows are Revo's product/runtime state around that workflow.
Revisium rows are never the authoritative store for run lifecycle facts.

The current catalogs in `@revisium/agent-playbook` are metadata, not an executable graph, and the package is not
compatible with the shipped importer end to end. The executable graphs stored in current `pipelines` rows come from
the product-owned built-in playbook under `control-plane/default-playbook/`.

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

Installed playbook metadata. The current row is not the Draft immutable full-package `PlaybookVersion` snapshot.

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

Imported pipeline definitions. Current product bootstrap rows carry executable templates. The canonical
`agent-playbook` catalog currently carries discovery, role-set, route-gate, and execution-policy recommendation
metadata only and cannot launch a run by itself.

Fields: `id, playbook_id, pipeline_id, path, triggers[], required_roles[], alternative_roles_json,
optional_roles[], route_gates[], platform_invocation, execution_policy_json, status, retired_at, updated_at`.

For the built-in default playbook, `execution_policy_json` carries the data-driven pipeline template. The base pipeline
owns workflow semantics only; provider/model/topology launch choices belong to `run_profiles`. When a catalog record
contains `execution_policy.template_json`, the importer validates it before serialization. Catalog metadata without a
template is not silently interpreted from Markdown.

### `run_profiles`

Versioned launch profiles scoped to an imported playbook and pipeline.

Fields: `id, playbook_id, pipeline_id, profile_id, schema_version, version, display_name, summary, profile_json,
profile_hash, profile_revision_hash, status, retired_at, source_path, source_hash, updated_at`.

`profile_json` stores the normalized launch payload: `schemaVersion`, `topology`, and `bindings`. Profile scope and
lifecycle metadata live in row columns such as `pipeline_id`, `profile_id`, `version`, and `status`. `profile_hash` is
pinned into Prisma `TaskRun.routeDecision` when a run is created. Catalog run profiles must pass the `run-profile/v1`
JSON Schema before they are serialized into `profile_json`. Seeded profiles are editable after import; profile updates
write a new Revisium revision. Launch-affecting edits write a new `profile_hash`; metadata/status edits can keep the
same `profile_hash` but write a new `profile_revision_hash` and must mark the row as user-edited for catalog
reconciliation.

`source_path` and `source_hash` record the last applied catalog source when a row came from default playbook import.
`source_hash` is the last applied normalized catalog profile hash, computed with the same normalization as
`profile_hash`. The normalized launch hash includes launch-affecting fields such as selected/storage pipeline id,
topology, bindings, and future launch policy fields; it excludes display/lifecycle/provenance row metadata. Catalog
reconciliation must not silently overwrite edits: import may update or retire only rows whose current `profile_hash`
still matches `source_hash`. User edits clear or otherwise invalidate `source_hash`, so metadata-only edits and
deprecations are preserved as customized rows.

The public pipeline/profile identifiers are `pipeline_id` and `profile_id`. The storage row `id` is an internal scoped
row id and is not accepted as a launch alias. When a catalog removes a profile, import may mark unchanged seeded rows
`status=removed`; runtime listing/resolution ignores removed rows.

Top-level publishing identity is outside the current `run-profile/v1` shape. GitHub account aliases are accepted as
validated script-node launch bindings in `profile_json`, for example `bindings.slots.integrator.accounts.github`.
Current `feature-development` materialization expands that convenience binding across its named PR lifecycle nodes.
This node-id expansion is a product-specific implementation fact, not a generic target: Draft ADR-0006 and the
resources/effects spec replace it with graph-declared logical capability/resource bindings.

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

The current `routeDecision` pins `requestedPipelineId`, `basePipelineId`, `profileSource`, `profileHash`, `profileSnapshot`,
`materializedTemplateHash`, `materializedTemplate`, `materializerVersion`, `policyVersion`, and resolved launch
bindings. Stored-profile launches also pin `profileId` and `profileVersion`; inline-profile launches omit or null
stored-profile identity fields and use `profileHash` as replay identity. Public launches are created from either a
stored `profileId` or an inline profile body, and Prisma stores the resolved normalized profile snapshot in both cases.
Replay uses this pin, not the latest Revisium profile row.

Launch configuration is stored in `routeDecision.profileSnapshot` and resolved launch bindings. There is no separate
Prisma column for profile-like launch overrides. The ACP runner session v1 target extends each agent launch binding
with a resolved model-profile snapshot before DBOS enqueue; the shipped schema still pins only `modelLevel` until that
migration lands. Replacement execution MUST use the resolved pin rather than re-read mutable Revisium meaning.

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

## Draft Target Boundary

The current tables above remain implementation truth. They do not by themselves establish the Draft target.

The Draft [playbook storage](./specs/playbook-storage-v1.spec.md) and
[execution plan](./specs/execution-plan-v1.spec.md) contracts replace the current partial import/pin with an immutable
installed `PlaybookVersion` and a fully resolved per-run `ExecutionPlan`. That plan pins every execution-affecting
graph, role, runner capability, script/effect, policy, resource/workspace, selected-context, and accepted-knowledge
input needed for recovery. Execution does not read mutable playbook HEAD or live registries.

The Draft [script runtime](./specs/script-runtime-v1.spec.md) contract owns script definition/execution records; the
Draft [resources, workspaces, and effects](./specs/resources-workspaces-effects-v1.spec.md) contract owns repository
and worktree lifecycle. Exact schemas stay in those specs rather than this inventory.

ADR/KB accepted revisions are Draft under ADR-0008. Run-authored proposals, review state, and future-run selection pins
must not be confused with hot Prisma run facts. The target is direct cutover for internal alpha data: no compatibility
rows, fallback reads, or dual-write old/new authority models.
