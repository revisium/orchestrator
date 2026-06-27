# Control-plane schema

The control plane is one Revisium project used by Revo for meaning and runtime projections. The authoritative
schema source is `control-plane/bootstrap.config.json`; this document is the human-readable ownership map.

## Ownership classes

| Table | Class | Revision behavior |
| --- | --- | --- |
| `playbooks` | Versioned meaning | committed; route/import reads `head` |
| `roles` | Versioned meaning | committed; execution reads `head` |
| `pipelines` | Versioned meaning | committed; run start reads and pins template meaning |
| `model_profiles` | Versioned meaning | committed; execution reads `head` |
| `routing_policy` | Versioned meaning | committed; route policy reads `head` |
| `task_runs` | Runtime projection | draft writes, never committed |
| `tasks` | Runtime projection | draft writes, never committed |
| `steps` | Retired compatibility table | defined but not part of the live engine contract |
| `attempts` | Runtime provenance | draft writes, never committed |
| `events` | Runtime journal | draft append, never committed |
| `inbox` | Runtime human queue | draft writes, never committed |
| `run_outputs` | Runtime dataflow artifacts | draft append, never committed |
| `cost_ledger` | Runtime accounting | draft append, never committed |

DBOS owns authoritative progress outside Revisium. Revisium runtime tables are projections, audit data, and human
interaction records.

## Schema rules

- Row identity is the Revisium row id. Explicit `id` fields are readability mirrors.
- Runtime rows are draft-only.
- Versioned meaning edits require a commit.
- Free-form JSON is stored in serialized string fields where the Revisium schema layer requires it.
- Product services should use data-access APIs, not raw table reads from transport adapters.

## Tables

### `task_runs`

Fields: `id, project_id, title, description, status, repos[], scope, priority, playbook_id, pipeline_id, params,
route_decision, execution_profile, created_by, created_at, updated_at`.

Serialized JSON fields: `params`, `route_decision`, `execution_profile`.

### `tasks`

Fields: `id, run_id, repo_ref, role_hint, title, status, depends_on[], scope, priority, created_at, updated_at`.

### `steps`

Compatibility table retained in schema for existing installations. The live data-driven engine does not use it as
the source of progress.

Fields: `id, task_id, run_id, role, kind, status, input, output, model_profile, run_after, attempt_count,
max_attempts, priority, depends_on[], lease_owner, lease_expires_at, dead_reason, created_at, updated_at`.

Serialized JSON fields: `input`, `output`.

### `attempts`

Per-attempt provenance for logs, verdict assertions, costs, and UI/MCP summaries.

Fields: `id, step_id, run_id, worker_id, attempt_no, status, idempotency_key, model_profile, input_tokens,
output_tokens, lesson, error, started_at, finished_at`.

### `events`

Append-only runtime journal.

Fields: `id, run_id, task_id, step_id, type, payload, actor, created_at`.

`payload` is serialized JSON and must be secret-redacted before write.

### `inbox`

Single human decision queue.

Fields: `id, kind, run_id, task_id, step_id, project_id, title, context, options[], status, answer, resolved_by,
created_at, resolved_at`.

`kind` values are `approval`, `question`, or `alert`. `status` values are `pending` or `resolved`.

Serialized JSON fields: `context`, `answer`.

### `roles`

Versioned role definitions.

Fields: `id, name, system_prompt, model_level, effort, runner_id, runner, allowed_tools[], scope_rules,
timeout_ms, permission_mode, playbook_id, playbook_role_id, source_path, source_hash, surface, rights, updated_at`.

`scope_rules` is serialized JSON. `runner` is a compatibility alias; `runner_id` is the preferred imported
playbook field. `timeout_ms` is the role-level runner wall-clock safety cap; `0` or an absent value uses the
runner default wall-clock cap and does not change the global idle timeout.

### `playbooks`

Installed playbook metadata.

Fields: `id, name, package_name, source, version, schema_version, manifest_path, roles_catalog_path,
pipelines_catalog_path, catalog_hash, installed_at, updated_at`.

### `pipelines`

Imported pipeline definitions.

Fields: `id, playbook_id, pipeline_id, path, triggers[], required_roles[], alternative_roles_json,
optional_roles[], route_gates[], platform_invocation, execution_policy_json, updated_at`.

`execution_policy_json` carries the data-driven pipeline template. Exact grammar lives in
[specs/pipeline-state-machine-v1.spec.md](./specs/pipeline-state-machine-v1.spec.md).

### `run_outputs`

Append-only runtime dataflow artifacts produced by pipeline nodes.

Fields: `id, run_id, node_id, ordinal, name, schema_ref, payload, payload_ref, attempt_id, produced_at`.

`payload` is serialized JSON, secret-redacted, and size-capped at the adapter boundary. `payload_ref` is set instead
of `payload` when content exceeds the inline cap.

### `model_profiles`

Versioned model-level mapping.

Fields: `id, level, provider, model_id, params, cost_per_input, cost_per_output, updated_at`.

Route and role data reference levels such as `cheap`, `standard`, and `deep`, not raw provider model ids.

### `routing_policy`

Versioned routing policy.

Fields: `id, rule, model_level, requires_human, updated_at`.

### `cost_ledger`

Append-only accounting rows.

Fields: `id, run_id, step_id, attempt_id, model_profile, input_tokens, output_tokens, cost_amount, currency,
recorded_at`.
