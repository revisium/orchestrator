# Plan 0014 — Emit a `run_cancelled` event when a run is cancelled

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** when `cancelRun` flips `task_runs.status` to `'cancelled'`, also append one
> audit row to the `events` table with `type: 'run_cancelled'`. This closes the explicit follow-up
> deferred by Plan 0013 (`0013-run-cancel-subcommand.md`, lines 14–17). The status-flip behavior,
> the `CancelRunResult` shape, the CLI subcommand, and the existing tests stay as they are; we only
> add the event write plus one test asserting it.
>
> **Out of scope (deferred / not this slice):**
> - **Cascading the event to child rows** (`tasks` / `steps`) or emitting per-step `step_cancelled`
>   events. This slice writes exactly one `run_cancelled` event for the run, mirroring how
>   `createRunWorkflow` writes exactly one `run_created` event.
> - **Looking up `task_id` / `step_id` to attach to the event.** `cancelRun` only receives a `runId`
>   and reads the `task_runs` row; it does not know the run's task/step ids without extra queries.
>   The event therefore carries `run_id` only (plus `previous_status` in the payload). Adding
>   `task_id`/`step_id` is a separate enrichment slice, not invented here.
> - **Exposing the new `eventId` on `CancelRunResult`.** `createRunWorkflow` returns its `eventId`
>   because callers mint all ids together; `cancelRun`'s public result (`{ runId, previousStatus,
>   status }`) is unchanged so the CLI output and its tests are untouched. The test asserts the event
>   id on the captured row instead.
> - **CLI output / messaging changes.** `runCancel` in `src/cli/commands/run.ts` (lines 183–196) keeps
>   printing the same "cancelled run … (was …)" / "already cancelled" lines. No new flags.
> - Numbering: `0012` and `0013` are taken (`0013` twice: `0013-revo-version-flag.md`,
>   `0013-run-cancel-subcommand.md`); `0009`/`0010`/`0011` are reserved by name in `../roadmap.md`.
>   This slice takes the next free number, `0014`.

---

## Design decisions (made for the implementor — do not relitigate without sign-off)

1. **Mirror the `steps.ts` "append an event to an already-existing run" pattern, NOT the `create-run.ts`
   id-minting pattern.** `createRunWorkflow` builds its event id from a slugged title stem
   (`src/run/create-run.ts`, `buildIds`, lines 155–166: `eventId: \`event_${stem}_created\``). That
   pattern needs a title to slug and mints all ids together. `cancelRun` instead appends an event to a
   run that already exists — exactly the situation `writeResult`/`failStep` handle in
   `src/control-plane/steps.ts`, where the id is `event_${st}_step-succeeded_${sfx}` (line 261) with
   `st = compactStamp(t)` (line 252) and `sfx = clockSuffix(opts)` (line 251). Follow that shape:
   `event_${compactStamp(now)}_run-cancelled_${suffix}`.

2. **Reuse the exported `compactStamp` rather than copying it.** `src/control-plane/steps.ts` line 56
   declares `export function compactStamp(date: Date): string`. `src/run/cancel-run.ts` line 1 already
   imports types from `../control-plane/index.js`; importing `compactStamp` from
   `../control-plane/steps.js` introduces no import cycle (`steps.ts` imports only `./data-access.js`
   and `./errors.js`, never anything under `src/run/`). Do **not** add a third private copy of the
   stamp helper.

3. **Default the suffix from `randomUUID`, but let the test inject it.** `cancelRun`'s current options
   are `opts?: { now?: Date }` (`src/run/cancel-run.ts` line 12). Extend to
   `{ now?: Date; idSuffix?: string }` so the new event id is deterministic in tests, mirroring
   `clockSuffix` in `steps.ts` (line 75–77) and `idSuffix` in `create-run.ts` (line 151). Default:
   `randomUUID().replaceAll('-', '').slice(0, 8)`.

4. **`actor: 'cli'`.** `createRunWorkflow` hardcodes `actor: 'cli'` on its `run_created` event
   (`src/run/create-run.ts` line 254). `cancelRun` is the cancel entry point invoked by the
   `revo run cancel` CLI handler (`src/cli/commands/run.ts` line 186), so hardcode `'cli'` to match.

5. **Write the event AFTER the status patch (event is the last write).** `createRunWorkflow` writes its
   row mutation(s) first and the `run_created` event LAST (`create-run.ts` lines 180–256, event at
   239–256). Mirror that ordering: keep the existing `patchRow('task_runs', …)` (`cancel-run.ts` lines
   22–25) as-is, then add `createRow('events', …)` after it, before `return`.

6. **Event id length stays ≤ 64.** Revisium rowIds cap at 64 chars (see `create-run.test.ts` line 234
   and the `steps.ts` child-id comment, lines 313–319). `event_` (6) + `compactStamp` (20, e.g.
   `20260604T000000000Z`) + `_run-cancelled_` (15) + 8-char suffix = 49 chars. Safe, fixed length — no
   slug to overflow.

---

## 1. Add the `run_cancelled` event write to `cancelRun`

**File:** `src/run/cancel-run.ts` (currently 28 lines).

**1a. Imports.** The file's only import today is line 1:

```ts
import type { ControlPlaneDataAccess } from '../control-plane/index.js';
```

Add, above or below it:

```ts
import { randomUUID } from 'node:crypto';
import { compactStamp } from '../control-plane/steps.js';
```

**1b. Extend the options type.** The signature today (lines 9–13) is:

```ts
export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date },
): Promise<CancelRunResult | null> {
```

Change the `opts` parameter to:

```ts
  opts?: { now?: Date; idSuffix?: string },
```

**1c. Append the event after the existing patch.** The current body's tail (lines 14–27) is:

```ts
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const previousStatus = typeof row.data.status === 'string' ? row.data.status : '';
  const nowIso = (opts?.now ?? new Date()).toISOString();

  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'cancelled' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { runId, previousStatus, status: 'cancelled' };
```

Insert the event write between the `patchRow(...)` call and the `return`, and derive the stamp/suffix
from the same `now` used for `nowIso`. The result is:

```ts
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const previousStatus = typeof row.data.status === 'string' ? row.data.status : '';
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();

  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'cancelled' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  const suffix = opts?.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8);
  const eventId = `event_${compactStamp(now)}_run-cancelled_${suffix}`;
  await da.createRow('events', eventId, {
    id: eventId,
    run_id: runId,
    type: 'run_cancelled',
    payload: { source: 'revo run cancel', previous_status: previousStatus },
    actor: 'cli',
    created_at: nowIso,
  });

  return { runId, previousStatus, status: 'cancelled' };
```

Notes:
- The previous `const nowIso = (opts?.now ?? new Date()).toISOString();` line is replaced by the
  two-line `now` / `nowIso` pair so `compactStamp(now)` and `created_at` share one timestamp.
- Do **not** add `task_id`/`step_id` to the event (out of scope above; `cancelRun` does not have them).
- Do **not** change `CancelRunResult` or the `return` value.

**Verify (this step):**

```
npx tsx --test src/run/cancel-run.test.ts
```

**Stop conditions:** If the existing cancel tests fail after only step 1 (before step 2 updates the
fake), that is expected ONLY if a test asserted "no create" on the success path — the current
`unknown runId` test asserts no create but returns before any write, so it must still pass. The two
status-flip tests assert `patches.length === 1` (not create counts) and must still pass. If any of the
five existing tests fail for another reason, **stop and report** — do not edit the assertions to fit.

---

## 2. Add a real test asserting the event is written

**File:** `src/run/cancel-run.test.ts` (currently 93 lines).

The existing fake's `createRow` (lines 24–27) records the call string but discards the data:

```ts
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
      return { rowId, data };
    },
```

**2a. Capture created rows.** Extend `makeFake` (lines 7–39) to collect created rows, mirroring how
`create-run.test.ts` keeps a `rows` array (that file, lines 16–20 + 44–49). Add a `creates` array:

```ts
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
```

(declare it next to `patches`, line 11), populate it inside `createRow`:

```ts
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
      creates.push({ table, rowId, data });
      return { rowId, data };
    },
```

and return it from `makeFake`: change `return { da, calls, patches };` (line 38) to
`return { da, calls, patches, creates };`.

**2b. Add the event test.** Append a new test (after line 92). Use a fixed `now` and `idSuffix` so the
id is deterministic:

```ts
test('known run emits a run_cancelled event', async () => {
  const { da, creates } = makeFake([RUN('running')]);
  const now = new Date('2026-06-04T00:00:00.000Z');
  await cancelRun(da, 'run-a', { now, idSuffix: 'abc123ef' });

  const events = creates.filter((c) => c.table === 'events');
  assert.equal(events.length, 1, 'exactly one event row written');
  const event = events[0];
  assert.equal(event.rowId, 'event_20260604T000000000Z_run-cancelled_abc123ef');
  assert.equal(event.data.id, event.rowId);
  assert.equal(event.data.type, 'run_cancelled');
  assert.equal(event.data.run_id, 'run-a');
  assert.equal(event.data.actor, 'cli');
  assert.equal(event.data.created_at, '2026-06-04T00:00:00.000Z');
  assert.deepEqual(event.data.payload, { source: 'revo run cancel', previous_status: 'running' });
});
```

**2c. Guard the no-write path.** The existing `unknown runId returns null and writes zero rows` test
(lines 46–54) already asserts `!calls.some((c) => c.startsWith('create:'))`, which still covers the
"no event on unknown run" case via the new `creates` capture. No change needed there; confirm it still
passes.

**Verify (this step):**

```
npx tsx --test src/run/cancel-run.test.ts
```

**Stop conditions:** All cancel-run tests (the five existing + the one new) must pass. If the id
assertion in 2b fails, **stop and report the actual id printed** — do not loosen the assertion to a
prefix match; a mismatch means the id-generation formula in step 1 differs from this plan and must be
reconciled, not hidden.

---

## Final verification & report

Run the full gate:

```
npm run verify
```

This runs `typecheck` + `lint:ci` + `test:cov` (see `package.json`). All must pass.

**Definition of done:**
- `cancelRun` writes exactly one `events` row with `type: 'run_cancelled'`, `run_id` = the cancelled
  run id, `actor: 'cli'`, and a `payload` carrying `source` + `previous_status`, in addition to the
  existing `task_runs` status flip.
- A real test asserts that event is written (id, type, run_id, actor, created_at, payload), and the
  five pre-existing cancel-run tests still pass.
- `CancelRunResult`, the CLI handler, and CLI output are unchanged.

**Delivery (per task context):** leave all changes **UNCOMMITTED** — the integrator commits. Work is on
branch `feat/run-cancelled-event`; the integrator uses the `gh` account `revisium-io`, base `master`,
an **empty** PR body, never force-pushes, and adds **no** `Co-Authored-By` trailer.

**Report:** state which files changed (`src/run/cancel-run.ts`, `src/run/cancel-run.test.ts`), the exact
`npm run verify` outcome (pass/fail with output), and confirm the changes are left uncommitted.
