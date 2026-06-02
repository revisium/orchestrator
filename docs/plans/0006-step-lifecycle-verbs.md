# Plan 0006 - Step lifecycle verbs

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** hot-path data-access verbs the worker loop will later call:
> `claimNextStep`, `startAttempt`, `writeResult`, `failStep`, `createSteps`, and `recoverInFlight`,
> plus opening `attempts` and `cost_ledger` in the runtime table set. **No process, no agents.**
> **Out of scope:** worker loop, runners, role/model-profile loading, context building, inbox,
> multi-worker lease reaping, and commits.

---

## 0. Context you must read first

- `docs/repo-layer-contract.md` - verb semantics and open questions.
- `docs/control-plane-schema.md` - `steps`, `attempts`, `events`, `cost_ledger` fields.
- `docs/architecture-overview.md` - loop pseudocode and recovery invariants.
- `docs/plans/0004-revisium-client-transport.md` - client/System API transport boundary.
- `docs/plans/0005-run-observability.md` - observed System API filter/order behavior.
- `src/control-plane/data-access.ts`
- `src/control-plane/tables.ts`
- `src/control-plane/json-fields.ts`
- `src/run/create-run.ts`

Key facts:

1. Every write targets draft and never commits.
2. These verbs are the only layer above generic data-access that should know hot table field names.
3. `attemptId` is minted in `startAttempt`, before any external effect.
4. MVP is single-worker. Read-then-write claim is acceptable; atomic conditional claim remains a later plug-in.
5. Multi-table writes flip `steps.status` last, so crashes do not falsely mark work as succeeded.

---

## 1. Open `attempts` and `cost_ledger`

**Files to change:**

- `src/control-plane/tables.ts`
- `src/control-plane/json-fields.ts` only if reality shows a JSON-ish field.

**Implementation notes:**

Plan 0002 originally opened only `task_runs`, `tasks`, `steps`, `events`, and `inbox`.
Add:

```ts
export const runtimeTables = [
  'task_runs',
  'tasks',
  'steps',
  'attempts',
  'events',
  'inbox',
  'cost_ledger',
] as const;
```

`attempts` and `cost_ledger` are scalar in the verified schema; do not add JSON serialization entries unless the
real schema proves otherwise.

**Verify:**

```bash
npm run typecheck
npm test
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:control-plane
```

**Stop conditions:**

- If `assertReady()` reports either table missing, stop. Do not create tables from runtime code.

---

## 2. Add step lifecycle module

**Files to create/change:**

- Create `src/control-plane/steps.ts`
- Create `src/control-plane/steps.test.ts`
- Change `src/control-plane/index.ts`

**Implementation notes:**

Expose domain verbs and types. Do not expose raw rows.

```ts
export type Step = {
  id: string;
  taskId: string;
  runId: string;
  role: string;
  kind: string;
  status: string;
  input: unknown;
  output: unknown;
  modelProfile: string;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  priority: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  deadReason: string;
};

export type NewStep = {
  taskId: string;
  runId: string;
  role: string;
  kind: string;
  input: unknown;
  modelProfile: string;
  priority?: number;
  maxAttempts?: number;
  dependsOn?: string[];
  runAfter?: string;
};

export type CostRecord = {
  modelProfile: string;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  currency?: string;
};
```

Add private mappers:

- snake_case row fields -> camelCase `Step`.
- defensive string/number coercion.
- no parsing of `steps.input` / `steps.output`; Plan 0004 data-access already handles JSON-ish fields.

Add deterministic clock/id injection for tests:

```ts
export type StepClock = { now?: Date; idSuffix?: string };
```

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- If a domain field lacks a schema counterpart, stop and report.
- If you need raw `fetch` or direct `@revisium/client` in this module, stop. Use `ControlPlaneDataAccess`.

---

## 3. `claimNextStep`

**Files to change:**

- `src/control-plane/steps.ts`
- `src/control-plane/steps.test.ts`

**Implementation notes:**

Signature:

```ts
claimNextStep(
  da: ControlPlaneDataAccess,
  workerId: string,
  roles: string[],
  opts?: { leaseTtlMs?: number } & StepClock,
): Promise<Step | null>
```

Behavior:

1. Select candidates with:
   - `status === 'ready'`
   - `run_after === '' || run_after <= now`
   - `role` is in `roles`
2. Sort by `priority` descending, then `created_at` ascending.
3. Use the filter mode proven in Plan 0005: System API server-side if it works, otherwise in-process with a cap.
4. Patch the chosen step:
   - `status = 'claimed'`
   - `lease_owner = workerId`
   - `lease_expires_at = now + leaseTtlMs`
   - `updated_at = now`
5. Return the claimed `Step`.

MVP comment to include: single-worker read-then-write is acceptable; atomic claim belongs only here later.

**Verify:**

```bash
npm test
npm run typecheck
```

Expected tests:

- highest-priority then oldest ready step is claimed.
- future `run_after` and wrong role are skipped.
- lease fields are written.
- no runnable step returns `null`.

---

## 4. `startAttempt`

**Files to change:**

- `src/control-plane/steps.ts`
- `src/control-plane/steps.test.ts`

**Implementation notes:**

Signature:

```ts
startAttempt(
  da: ControlPlaneDataAccess,
  step: Step,
  opts: { workerId: string; modelProfile?: string } & StepClock,
): Promise<{ attemptId: string; idempotencyKey: string }>
```

Behavior:

1. Mint `attemptId` and `idempotencyKey` before external work.
2. Create `attempts[attemptId]` with `status = 'running'` and `attempt_no = step.attemptCount + 1`.
3. Patch the step to `status = 'running'`.
4. Return ids.

Attempt row is written before step status flips to `running`.

**Verify:**

```bash
npm test
npm run typecheck
```

---

## 5. `writeResult` and `createSteps`

**Files to change:**

- `src/control-plane/steps.ts`
- `src/control-plane/steps.test.ts`

**Implementation notes:**

`writeResult` records success:

1. Close the attempt as `succeeded`.
2. Append `step_succeeded` event.
3. Append `cost_ledger` rows for supplied `CostRecord[]`.
4. Last: patch the step to `status = 'succeeded'`, set `output`, update timestamp.

`createSteps` inserts next steps:

- generated `stepId`
- `ready` when no `dependsOn`, otherwise `pending`
- full `steps` schema fields filled
- `attempt_count = 0`
- no attempt row
- optional `step_created` event

**Verify:**

```bash
npm test
npm run typecheck
```

Expected tests:

- step status write happens after attempt/event/cost writes.
- empty costs write no `cost_ledger` rows.
- `createSteps` never creates attempts.

**Stop conditions:**

- If partial failure can falsely mark a step succeeded, stop and revisit write ordering.

---

## 6. `failStep` and `recoverInFlight`

**Files to change:**

- `src/control-plane/steps.ts`
- `src/control-plane/steps.test.ts`

**Implementation notes:**

`failStep`:

1. Close attempt as `failed`, with compressed `lesson` and `error`.
2. Append `step_failed` event.
3. Increment attempt count.
4. If attempts remain: step `ready` with future `run_after`.
5. If cap reached: step `dead` with `dead_reason`.

`recoverInFlight(da, workerId)`:

- Find steps owned by `workerId` with status `claimed` or `running`.
- Reset only those steps to `ready`, clear lease fields.
- Close open running attempts as failed with lesson `worker crashed mid-step`.
- Append `step_recovered` event.
- Do not implement global expired-lease reaping.

**Verify:**

```bash
npm test
npm run typecheck
```

Expected tests:

- under max attempts -> backoff to ready.
- at max attempts -> dead.
- recovery is owner-scoped and ignores other workers.

---

## 7. Live smoke

**Files to create/change:**

- Create `scripts/smoke-step-lifecycle.ts`
- Add `"smoke:step-lifecycle": "tsx scripts/smoke-step-lifecycle.ts"` to `package.json`

**Implementation notes:**

Smoke:

1. Use `revo run create` to create a ready step.
2. Claim, start attempt, write result; assert step/attempt/event/cost rows.
3. Create another step, claim/start, simulate crash, call recovery; assert ready again and orphan attempt failed.
4. Optionally exercise `failStep` to ready/dead.

Must not commit runtime rows.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:step-lifecycle
```

---

## 8. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm install
npm run build
npm run typecheck
npm test
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:create-run
npm run smoke:step-lifecycle
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** lifecycle verbs move steps through claim/running/succeeded/failed/recovered states,
attempts and cost rows are written through draft data access, step status flips last on success, owner-scoped
recovery works, tests and smoke pass, and no runtime commit path is touched.

---

## 9. Report back / open findings

Report:

1. Exported verb signatures.
2. Filter mode and cap used by `claimNextStep`.
3. Smoke status transitions.
4. Validation outputs.
5. Confirmation no commit path was touched.

Open findings:

- atomic conditional claim for multiple workers.
- global expired lease reaping.
- cross-table transactions if Revisium exposes them later.
