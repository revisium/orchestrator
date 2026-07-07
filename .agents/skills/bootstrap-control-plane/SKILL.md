---
name: bootstrap-control-plane
description: Verify the embedded Revo control-plane bootstrap.
---

# Bootstrap control plane

Verify the control-plane tables from `control-plane/bootstrap.config.json` through the embedded Revo host bootstrap.

## Rules

- Bootstrap is owned by Revo startup. Use only the top-level Revo lifecycle commands; legacy storage commands are
  unsupported.
- `bootstrapEngineControlPlane` runs before the host starts serving. A startup failure means the control plane is not
  ready.
- Do not hand-edit engine tables. Edit `control-plane/bootstrap.config.json`, then verify through startup/tests/smoke.
- Runtime rows remain draft-only; versioned meaning rows are committed by the embedded engine path.

## Workflow

1. Start the stack with an isolated profile/env when touching state: `revo start` or `pnpm run revo -- start --profile dev`.
2. Check `revo status` and `revo doctor`; GraphQL should be healthy and the host should have written `host.json`.
3. For source checkout verification, run `pnpm run smoke:control-plane` with explicit temp `REVO_DATA_DIR`, `REVO_PORT`,
   `REVO_PG_PORT`, `REVO_DB`, and `REVO_DBOS_DB`.
4. Verify the runtime tables (`task_runs, tasks, steps, attempts, events, inbox, roles, model_profiles,
   routing_policy, cost_ledger`) through the control-plane API/smoke output.
5. Confirm the versioned-vs-runtime split per `docs/control-plane-schema.md`.
