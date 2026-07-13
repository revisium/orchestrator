# Control-plane schema

This page records current ownership for the Revo control plane. It is implementation documentation, while the
linked execution-plan and run-profile documents remain Draft until final review and gates.

## Ownership

- DBOS owns durable workflow progress, retries, waits, queues, checkpoints, and workflow replay.
- Revo Prisma owns runtime facts: projects, runs, tasks, events, attempts, inbox items, outputs, and cost ledger
  entries.
- Embedded Revisium owns committed/versioned meaning: playbooks, role meaning, provider-neutral pipelines, routing
  policy, and run profiles.
- Git, worktrees, and files own repository state, diffs, logs, and large artifacts.
- MCP and GraphQL are transport adapters over application services; they do not read raw storage.

`control-plane/bootstrap.config.json` is the bootstrap source for Revisium meaning tables. `prisma/schema.prisma`
and migrations are the source for Prisma runtime tables and generated client artifacts.

## Meaning tables

The bootstrap meaning table set is:

| Table | Meaning |
| --- | --- |
| `playbooks` | Installed playbook identity and catalog provenance. |
| `roles` | Versioned role meaning: prompt, tools, scope, rights, and playbook provenance. |
| `pipelines` | Versioned provider-neutral graph templates, triggers, route gates, and execution policy data. |
| `routing_policy` | Runtime policy limits and human-gate policy data; it does not select a model. |
| `run_profiles` | Versioned exact launch configuration scoped to a playbook and pipeline. |

Roles do not carry runner, provider, model, timeout, or permission defaults. Pipelines do not carry provider/model
launch choices or role-list launch authority. A graph's `roleRef` and `scriptRef` nodes determine executable
obligations.

## Bootstrap and catalog rules

The bootstrap file contains strict schemas and rows for the five meaning tables above. Role catalog records retain
meaning fields only. Pipeline catalog records retain opaque graph semantics. Run-profile catalog records contain
catalog metadata plus the exact `run-profile/v1` body.

Catalog import rejects unknown launch-authority fields, invalid graph templates, invalid profile bodies, duplicate ids,
and profile references to unknown pipelines. It validates the same profile body used by profile management and route
planning. Current catalogs contain concrete model ids as profile configuration only; no separate model registry or
price table is loaded.

## `run_profiles`

Stored row fields are:

`id`, `playbook_id`, `pipeline_id`, `profile_id`, `schema_version`, `version`, `display_name`, `summary`,
`profile_json`, `profile_hash`, `profile_revision_hash`, `status`, `retired_at`, `source_path`, `source_hash`, and
`updated_at`.

`profile_json` stores only:

```json
{
  "schemaVersion": "run-profile/v1",
  "topology": { "stages": {} },
  "bindings": { "slots": {} }
}
```

Agent slots use exact `runnerId`, `provider`, `modelId`, required `modelParams`, and optional permission/timeout.
Script slots contain account aliases only. Account aliases are not credentials. `modelParams` is separate from run
business parameters and is secret-free.

The public profile id is `profile_id`; an internal scoped row id is not a launch alias. Stored profiles can be listed,
read, validated, created, updated with an optimistic revision hash, or deprecated. Deprecated rows remain readable when
requested but are rejected by launch resolution.

## Prisma runtime models

`TaskRun` stores the run identity and the `routeDecision` JSON envelope. The envelope contains
`route-decision/v1` plus canonical `executionPlanBytes` and `executionPlanDigest`, with a read-only route projection.
The plan bytes/digest are written before DBOS enqueue and are the sole execution authority.

The execution plan pins the selected playbook/pipeline, normalized business parameters, profile provenance, materialized
graph and hash, route gates, execution policy, exact resolved agent bindings, exact script account bindings, and runner
manifest snapshots. A public response may also expose a decoded read-only plan view derived from those bytes; it is not
stored as a second executable object.

`RunTask.roleHint` is a display/runtime skeleton field. It is not used to choose a runner or model. The workflow reads
the plan bindings by graph node.

`RunAttempt` fields include exact `runnerId`, `provider`, and `modelId` provenance plus nullable `inputTokens`,
`outputTokens`, `costAmount`, and `currency`. `CostLedgerEntry` carries the same exact provenance and nullable usage.
A reported cost, including zero, defaults to currency `USD` when the runner omits a currency. Currency alone does not
create a cost row. No model price is calculated.

Events are append-only and payloads are secret-redacted. Outputs are node-scoped runtime dataflow artifacts. Inbox
items are human decisions. None of these tables resolves mutable launch configuration.

## Public route and profile operations

MCP and GraphQL expose the same application-service operations:

- `list_profiles` / `runProfiles`;
- `get_profile` / `runProfile`;
- `validate_profile` / `validateRunProfile`;
- `create_profile` / `createRunProfile`;
- `update_profile` / `updateRunProfile`; and
- `deprecate_profile` / `deprecateRunProfile`.

`create_run` and `simulate_route` require a pipeline id and exactly one stored profile id or inline profile. Both use
the same compiler and return the same canonical plan bytes/digest plus decoded slot pins. A missing or deprecated
stored profile, invalid profile, provider mismatch, invalid manifest default, unbound slot, unknown slot, or script
binding misuse maps to a stable validation error.

No public operation exposes a model resource, model alias, price list, allowed-model list, or availability probe.

## Fresh-alpha reset/reseed boundary

Schema changes in this tranche are fresh-alpha DDL changes. Validation uses repository-supported Prisma generation,
validation, reset/reseed fixtures, and catalog installer tests. Legacy rows are not transformed or read through a
compatibility migration. Historical migration SQL may retain old dropped-column names only as DDL history.

## Draft target

The Draft [execution-plan-v1.spec.md](./specs/execution-plan-v1.spec.md) and related resource/workspace specs may
expand the immutable plan with installed-package and resource provenance. That future work must preserve this
authority chain:

```text
provider-neutral graph + exact RunProfile
        -> compiled plan bytes/digest
        -> persisted TaskRun route envelope
        -> DBOS workflow/recovery reads the stored plan only
```
