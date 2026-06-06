# Plan 0002 — Revisium as a NestJS module (meaning)

> **Status: Draft.** Wraps the existing Revisium data-access as Nest providers.
> **Depends on:** [0001](./0001-nest-host-and-dbos-bootstrap.md) · [control-plane-schema.md](../control-plane-schema.md)
> (post-pivot: meaning tables only) · [repo-layer-contract.md](../repo-layer-contract.md).
> **Realizes:** invariant #4 — Revisium table knowledge sealed in one module.

## Scope

Expose Revisium's **meaning** state (roles, model profiles, inbox, runs) behind a single `RevisiumModule` with
injectable providers. This is the only place that knows Revisium's tables; the workflow (0003) and CLI consume
verbs, never `@revisium/client` directly.

## Non-goals

- No DBOS progress state here (that is DBOS-owned).
- The legacy step-lifecycle verbs (`claimNextStep`/`startAttempt`/`writeResult`/`failStep`/`recoverInFlight`) are
  **not** wired — mark them legacy; deletion is post-MVP cleanup.

## Files to create / change

- `src/revisium/revisium.module.ts` — provides:
  - `RevisiumTransport` (draft + head) — wrap `createClientTransport` from `src/control-plane/client-transport.ts`.
  - `RolesService` — `loadRole`, `loadModelProfile` (head reads) from `src/control-plane/definitions.ts`.
  - `InboxService` — `buildInboxRow`, `listInbox`, `resolveInbox` from `src/control-plane/inbox.ts`.
  - `RunService` — `createRunWorkflow`, `listRuns`, `showRun`, `listRunEvents`, `cancelRun` from `src/run/*`.
- `src/revisium/*.service.ts` — thin DI wrappers around the existing pure functions.

## Reference code (reuse as-is)

- `src/control-plane/data-access.ts` (`ControlPlaneDataAccess`, `createControlPlaneDataAccess*`).
- `src/control-plane/client-transport.ts` (`createClientTransport(mode)`).
- `src/control-plane/definitions.ts` (`loadRole`, `loadModelProfile`).
- `src/control-plane/inbox.ts` (`buildInboxRow`, `listInbox`, `resolveInbox`).
- `src/control-plane/json-fields.ts`, `errors.ts`, `tables.ts` (unchanged).
- `src/run/create-run.ts`, `inspect-run.ts`, `cancel-run.ts`.

## Tasks

1. Create `RevisiumModule` providing the transport (draft + head) from config (org/project/branch in `config.ts`).
   **Verify:** `assertReady()` passes against a running standalone.
2. Wrap `RolesService` (`loadRole`/`loadModelProfile`).
   **Verify:** seed a role row; `RolesService.loadRole('analyst')` returns it from `head`.
3. Wrap `RunService` and `InboxService`; route the existing `run`/`inbox` CLI commands through them.
   **Verify:** `revo run create` writes run/task/event rows; `revo run show <id>` reads them back; `revo inbox
   list` returns pending rows.

## Acceptance test

- All `run`/`inbox` CLI commands work through Nest providers (no direct `@revisium/client` use outside
  `RevisiumModule`).
- `npm run lint:ci` + `tsc` clean; existing `node:test` suites for control-plane/run still pass.
