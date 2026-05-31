---
name: bootstrap-control-plane
description: Apply and verify the orchestrator control-plane schema (10 tables) on the local Revisium.
---

# Bootstrap control plane

Create/verify the control-plane tables from `control-plane/bootstrap.config.json` via revisium-cli.

## Rules

- The daemon must be healthy first — see [[run-revisium]].
- Schema is committed **once** (`--commit`); runtime rows are never committed (versioning boundary).
- Do not hand-edit tables in the Admin UI — edit `control-plane/bootstrap.config.json` and re-bootstrap
  (idempotent: existing tables report `skipped`).

## Workflow

1. Ensure Revisium is running: `revo revisium status`.
2. `revo bootstrap --commit`.
3. Verify the 10 tables (`task_runs, tasks, steps, attempts, events, inbox, roles, model_profiles,
   routing_policy, cost_ledger`): re-run `revo bootstrap` (expect `skipped`) or open the Admin UI at `/`.
4. Confirm the versioned-vs-runtime split per `docs/control-plane-schema.md`.
