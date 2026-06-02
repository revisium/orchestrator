# Plan 0005 - Read-only run observability CLI

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** read-only inspection of control-plane state from the CLI: `revo run list`,
> `revo run show <runId>`, and `revo run events <runId>`, with optional `--json`. Reads go through the
> Plan 0004 `@revisium/client` / System API data-access layer against draft. **Out of scope:** writes,
> step claiming, worker loop, runners, versioned definition reads, commits, pagination UX beyond `--limit`,
> and live `--follow`.

---

## 0. Context you must read first

- `docs/plans/0004-revisium-client-transport.md` - the data-access transport this plan consumes.
- `docs/plans/0003-create-run-workflow.md` - row shapes written by `revo run create`.
- `docs/control-plane-schema.md` - table and field names.
- `src/control-plane/data-access.ts` - `listRows`, `getRow`, `ControlPlaneRow`, `ListRowsOptions`.
- `src/run/create-run.ts` - exact fields persisted by create.
- `src/cli/commands/run.ts` - existing `run` command group.
- `scripts/smoke-create-run.ts` - smoke style.

Key facts:

1. Reads only. This slice never writes a row and never commits.
2. Runtime reads target draft through the Plan 0004 client-backed data access.
3. No raw `fetch`, no generated endpoint URL construction, no direct `@revisium/client` calls in CLI command
   handlers. Keep the data-access boundary.
4. JSON-ish fields (`steps.input`, `steps.output`, `events.payload`) are already deserialized by data access.
5. `where` / `orderBy` must be verified against the System API scope, not the generated endpoint.

---

## 1. Command contract

Implement these commands under the existing `run` group:

```bash
revo run list   [--status <status>] [--limit <n>] [--json]
revo run show   <runId> [--json]
revo run events <runId> [--type <type>] [--limit <n>] [--json]
```

In scope:

- `run list`: newest runs first, compact human output or JSON.
- `run show`: run header, tasks, and grouped steps.
- `run events`: chronological event journal for one run.
- pure read module and pure formatters.
- live smoke script.

Out of scope:

- writes, mutations, claiming, leases, worker loop, runners, `roles`/`model_profiles`, `--follow`, TUI, table
  library, top-level `task` or `step` commands.

---

## 2. Preconditions

**Files to create/change:** none.

**Implementation notes:**

Confirm Plan 0004 and 0003 are in place:

- `createControlPlaneDataAccess()` uses the client-backed transport.
- `src/cli/commands/run.ts` already registers `run create`.
- `src/run/create-run.ts` exists and tests pass.

**Verify:**

```bash
test -f src/control-plane/data-access.ts
test -f src/run/create-run.ts
test -f src/cli/commands/run.ts
npm run typecheck
npm test
```

**Stop conditions:**

- If data access still constructs `/endpoint/rest/...`, stop and report. Plan 0004 must land first.
- If `run create` is missing, stop. Plan 0003 must land first.

---

## 3. Verify System API filtering and ordering

**Files to create/change:** none in this step; record the result in the report.

**Implementation notes:**

Use the Plan 0004 data-access layer or `@revisium/client` scope directly in a throwaway script to verify the
real accepted shape for `where` and `orderBy`.

Minimum probe after creating at least one run:

```bash
node --input-type=module - <<'JS'
import { createControlPlaneDataAccess } from './dist/control-plane/index.js';
const da = createControlPlaneDataAccess();
await da.assertReady();
const runs = await da.listRows('task_runs', { first: 10 });
const runId = runs[0]?.rowId;
console.log({ runId, count: runs.length });
if (runId) {
  console.log(await da.listRows('tasks', { first: 100, where: { run_id: { equals: runId } } }));
}
JS
```

If System API honors `where` and `orderBy`, push filters into `listRows`.
If it rejects or ignores them, filter/sort in process with a cap (for example 500) and report the cap.

**Stop conditions:**

- If the accepted filter shape differs from `{ field: { equals: value } }`, record and use the actual shape.
- If neither server-side nor in-process filtering can produce correct per-run output within the cap, stop.

---

## 4. Add the read module

**Files to create/change:**

- Create `src/run/inspect-run.ts`
- Create `src/run/inspect-run.test.ts`

**Implementation notes:**

Keep read logic command-independent.

```ts
export type RunSummary = {
  runId: string;
  title: string;
  status: string;
  priority: number;
  createdAt: string;
};

export type StepSummary = {
  stepId: string;
  role: string;
  kind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
};

export type TaskSummary = {
  taskId: string;
  title: string;
  status: string;
  roleHint: string;
  steps: StepSummary[];
};

export type RunDetail = {
  run: RunSummary & { description: string; scope: string; repos: string[] };
  tasks: TaskSummary[];
};

export type EventSummary = {
  eventId: string;
  type: string;
  actor: string;
  createdAt: string;
  taskId: string;
  stepId: string;
};

export async function listRuns(da: ControlPlaneDataAccess, filter?: { status?: string; limit?: number }): Promise<RunSummary[]>;
export async function showRun(da: ControlPlaneDataAccess, runId: string): Promise<RunDetail | null>;
export async function listRunEvents(da: ControlPlaneDataAccess, runId: string, filter?: { type?: string; limit?: number }): Promise<EventSummary[]>;
```

Rules:

- Call `da.assertReady()` once at the start of each public function.
- Sort `task_runs` by `created_at` descending.
- Sort tasks/steps by `created_at` ascending for stable `show`.
- Sort events by `created_at` ascending.
- Defensively coerce missing fields.
- Return plain domain shapes, not `ControlPlaneRow`.

**Verify:**

```bash
npm run typecheck
npm test
```

Expected tests:

- `listRuns` sorts newest-first and honors `status` + `limit`.
- `showRun` groups steps under the correct task and returns `null` for unknown runId.
- `listRunEvents` sorts oldest-first and honors `type` + `limit`.
- every function calls `assertReady()`.
- fake data-access records zero writes.

**Stop conditions:**

- If grouping needs a field the schema lacks, stop and report.
- If JSON-ish fields arrive as strings, stop; Plan 0004/0002 deserialization is broken.

---

## 5. Human and JSON formatting

**Files to create/change:**

- Add pure formatters in `src/run/inspect-run.ts` or `src/run/format-run.ts`
- Add formatter tests

**Implementation notes:**

Suggested human output:

```text
RUN                         STATUS  PRI  CREATED               TITLE
run_20260601_ab12cd34       ready   1    2026-06-01T00:05:12Z  Smoke create run
(1 run)
```

`--json` must emit only `JSON.stringify(value, null, 2)` to stdout.

**Verify:**

```bash
npm test
npm run typecheck
```

**Stop conditions:**

- Do not add a table-formatting dependency.

---

## 6. Register CLI commands

**Files to change:**

- `src/cli/commands/run.ts`

**Implementation notes:**

Extend the existing `run` group; do not create a second group.

Behavior:

- Build data access with `createControlPlaneDataAccess()`.
- Parse `--limit` as integer and reject invalid values.
- Unknown run for `show`/`events`: print `run not found: <runId>` to stderr and exit non-zero.
- Reuse current control-plane error formatting/hints.
- `--help` must work without daemon running.

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- run --help
npm run revo -- run list --help
```

Expected: `run --help` lists `create`, `list`, `show`, `events`.

---

## 7. Live smoke

**Files to create/change:**

- Create `scripts/smoke-inspect-run.ts`
- Add `"smoke:inspect-run": "tsx scripts/smoke-inspect-run.ts"` to `package.json`

**Implementation notes:**

Smoke flow:

1. Spawn `revo run create` with a unique title; capture ids.
2. `revo run list --json`; assert the run appears.
3. `revo run show <runId> --json`; assert run, task, and ready step are linked.
4. `revo run events <runId> --json`; assert `run_created`.
5. Run human output paths and assert non-empty stdout.
6. Re-read rows and confirm observability did not mutate status/attempt count.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:inspect-run
```

---

## 8. Final acceptance test

```bash
cd /Users/anton/projects/revisium/agent-orchestrator
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm install
npm run build
npm run typecheck
npm test
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:create-run
npm run smoke:inspect-run
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** list/show/events work in human and JSON modes, unknown run ids fail cleanly, no writes
occur, tests and smokes pass, and the daemon is stopped.

---

## 9. Report back / open findings

Report:

1. Final syntax for `list`, `show`, `events`.
2. Observed System API filter/order behavior and chosen mode.
3. Example human and JSON output.
4. Validation outputs.
5. Confirmation no write/commit path was touched.

Open findings:

- cursor pagination beyond `--limit`
- `--follow`
- top-level `task` / `step` inspection
- inbox inspection

### Inherited from 0004 review

- **getScope() scope per call:** `getScope()` rebuilds the client and makes 2 extra round-trips
  (`fetchHead` / `fetchDraft`) on every transport method call; one `getRow` = 3 HTTP calls. Memoize
  the scope per transport instance.
- **updateRow/patchRow non-null assertion:** `updateRow` and `patchRow` use `result.data!.row!` double
  non-null, but `row?` is optional in those response types — guard and raise
  `HTTP_ERROR('Malformed response')` instead of letting a `TypeError` escape.
- **ListRowsOptions type gap:** `ListRowsOptions.where` / `orderBy` are `Record<string,unknown>` cast
  with `as` into the SDK body, silencing type mismatch; tighten when filter semantics land in 0005.
