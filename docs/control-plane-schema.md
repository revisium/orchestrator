# Control-plane schema

> **Status: verified.** The source of truth for the schema is `control-plane/bootstrap.config.json`; this doc is
> the human-readable reference.
> **Depends on:** [architecture-overview.md](./architecture-overview.md) (the versioning boundary) ·
> `control-plane/bootstrap.config.json` (authoritative schema).
> **Realized by:** [plans/0001-revisium-daemon-and-bootstrap.md](./plans/0001-revisium-daemon-and-bootstrap.md).

The control plane is one Revisium project (`admin/control-plane/master`) — the "exchange bus." Ten tables.

## Versioned vs. runtime (the boundary, per table)

| Table | Class | Revision behavior |
| --- | --- | --- |
| `roles` | **Versioned** | edited via commit; loop reads committed `head` |
| `model_profiles` | **Versioned** | edited via commit; loop reads `head` |
| `routing_policy` | **Versioned** | edited via commit; loop reads `head` |
| `task_runs` | Runtime | draft writes, never committed |
| `tasks` | Runtime | draft writes, never committed |
| `steps` | Runtime (**hot**) | draft writes, never committed |
| `attempts` | Runtime | draft writes, never committed |
| `events` | Runtime (append-only) | draft writes, never committed |
| `inbox` | Runtime | draft writes, never committed |
| `cost_ledger` | Runtime (append-only) | draft writes, never committed |

Table **schema** creation is committed once (structural). Runtime **rows** are never committed — see
[repo-layer-contract.md](./repo-layer-contract.md).

Identity: each row's identity is the Revisium **rowId**. An explicit `id` field is kept for readability but rowId
is canonical.

Schema compatibility notes from the verified bootstrap:

- Object schemas include `required` arrays because the current Revisium schema store expects them.
- String arrays are Revisium arrays with `items: { type: "string", default: "" }`; the array itself has no
  `default`.
- Free-form JSON fields are serialized into `string` fields. `additionalProperties: true` is not accepted by the
  current Revisium schema meta-schema.

## Tables (fields from brief §5)

### `task_runs` — a run (may span several repos)
`id, project_id, title, description, status, repos[], scope, priority, created_by, created_at, updated_at`
Status: `pending → planning → ready → running → (completed | failed | awaiting_approval | paused | cancelled)`

### `tasks` — a logical task inside a run
`id, run_id, repo_ref, role_hint, title, status, depends_on[], scope, priority, created_at, updated_at`

### `steps` — the atomic unit of work (HOT)
`id, task_id, run_id, role, kind, status, input, output, model_profile, run_after, attempt_count, max_attempts,
priority, lease_owner, lease_expires_at, dead_reason, created_at, updated_at`
Status: `pending → ready → claimed → running → (succeeded | failed→ready | dead | awaiting_approval | skipped)`
`lease_owner` / `lease_expires_at` exist from day one even though the MVP reaper is unused.
`input` and `output` store serialized JSON.

### `attempts` — one execution attempt of a step
`id (generated BEFORE the run), step_id, run_id, worker_id, attempt_no, status, idempotency_key, model_profile,
input_tokens, output_tokens, lesson, error, started_at, finished_at`
`lesson` = compressed takeaway of a failed attempt ("tried X, failed at Y") — feeds restart context, not raw logs.

### `events` — append-only journal
`id (monotonic), run_id, task_id, step_id, type, payload, actor, created_at` · INSERT only; redact secrets.
`payload` stores serialized JSON.

### `inbox` — single human queue
`id, kind (approval|question|alert), run_id, task_id, step_id, project_id, title, context, options[],
status (pending|resolved), answer, resolved_by, created_at, resolved_at` · Global, never split per project.
`context` and `answer` store serialized JSON.

### `roles` — role definitions (VERSIONED)
`id, name (architect|developer|reviewer|integrator|ci-poller|pr-watcher), system_prompt, model_level (cheap|standard|deep),
effort, runner (claude-code|codex|script), allowed_tools[], scope_rules, updated_at`
`scope_rules` stores serialized JSON.

### `model_profiles` — level → real model (VERSIONED)
`id, level (cheap|standard|deep), provider, model_id, params, cost_per_input, cost_per_output, updated_at` ·
Routing is by named level, never a raw model string.
`params` stores serialized JSON.

### `routing_policy` — level/approval rules (VERSIONED)
`id, rule, model_level, requires_human (bool), updated_at`
`rule` stores serialized JSON.

### `cost_ledger` — cost accounting (append-only)
`id, run_id, step_id, attempt_id, model_profile, input_tokens, output_tokens, cost_amount, currency, recorded_at`
