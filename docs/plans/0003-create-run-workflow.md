# Plan 0003 - Create-run CLI workflow

> **Audience:** an implementing coding agent (low-capability model). Follow the steps **in order**.
> Each step lists the exact files to create/change, implementation notes, a **Verify** command, and stop
> conditions. Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** the first executable user workflow on top of Plan 0002: `revo run create` writes a
> run/task/initial-step skeleton plus a creation event into Revisium draft runtime rows. **Out of scope:** worker
> loop, step claiming, leases, scheduling, runners, model provider selection beyond placeholders, prompt
> execution, human inbox UI, automatic git/PR work, roles/model_profiles seed data, and committing runtime rows.

---

## 0. Context you must read first (do not skip)

Read these real files before writing code:

- `docs/plans/0001-revisium-daemon-and-bootstrap.md` - daemon/bootstrap baseline and runtime revision boundary.
- `docs/plans/0002-control-plane-data-access.md` - required data-access API for this slice.
- `docs/getting-started.md` - how to start/bootstrap the local control plane.
- `docs/control-plane-schema.md` - field names and runtime/versioned split.
- `docs/architecture-overview.md` - CLI/state invariants.
- `control-plane/bootstrap.config.json` - authoritative schemas.
- `src/cli/index.ts` and `src/cli/commands/*.ts` - current CLI registration style.

Key facts this slice must preserve:

1. Runtime writes target `admin/control-plane/master:draft` through the Plan 0002 data-access layer.
2. Runtime writes are **never committed**. Do not call `bootstrap --commit`, `create_revision`, or any commit API
   after creating run rows.
3. The CLI is project lifecycle control, not a chat interface and not a terminal replacement.
4. This command creates persisted state only. It does not execute prompts, pick providers, claim steps, or spawn
   workers.
5. Plan 0002 owns HTTP/REST details and JSON-ish field serialization. This slice must not duplicate that logic.

---

## 1. Scope and command contract

Implement this command shape:

```bash
revo run create --title <title> --repo <path-or-name> [--description <text>] [--scope <text>] [--priority <n>]
```

Keep this exact shape unless reality contradicts it. It is intentionally lifecycle-oriented: a user creates a
control-plane run, then later worker slices execute ready steps from Revisium.

### In scope

Register a new `run` command group and add `run create`.

The command creates exactly these draft runtime rows:

- one `task_runs` row
- one `tasks` row
- one initial `steps` row
- one `events` row documenting creation

It prints the created IDs and a concise status line.

### Out of scope

Do not implement any of these:

- worker loop
- step claiming / leases
- scheduling
- runners
- model provider selection beyond a placeholder string
- prompt execution
- human inbox UI
- automatic git/PR work
- committing runtime rows
- seeding `roles` or `model_profiles`

Do not add a chat-style command, free-form terminal proxy, or broad domain framework.

---

## 2. Preconditions - prove Plan 0002 exists as code

**Files to create/change:** none.

**Implementation notes:**

This slice depends on the Plan 0002 implementation, not only the Plan 0002 document. Before writing code, confirm
the data-access layer exists and exposes the API named in Plan 0002.

Required Plan 0002 files/APIs:

- `src/control-plane/data-access.ts`
- `src/control-plane/index.ts`
- `createControlPlaneDataAccess()`
- `ControlPlaneDataAccess`
- `createRow(table, rowId, data)`
- `getRow(table, rowId)`
- `listRows(table, options?)`
- `assertReady()`
- JSON-ish field handling for:
  - `steps.input`
  - `steps.output`
  - `events.payload`

If Plan 0002 used slightly different file names, read its final implementation and adapt imports only after
verifying the same behavior exists. Do not reimplement HTTP calls in this slice.

**Verify:**

```bash
test -f src/control-plane/data-access.ts
test -f src/control-plane/index.ts
npm run typecheck
npm test
```

**Stop conditions:**

- If the Plan 0002 implementation is missing, stop and report: "Plan 0002 implementation is required before
  Plan 0003."
- If `createControlPlaneDataAccess()` or equivalent row methods do not exist, stop and report the real exported
  API. Do not duplicate REST logic inside the CLI command.
- If Plan 0002's JSON-ish serialization helpers are not wired into `createRow`, stop and finish Plan 0002 first.

---

## 3. Add the create-run service, keeping it small

**Files to create/change:**

- Create `src/run/create-run.ts`
- Create `src/run/create-run.test.ts`

**Implementation notes:**

Put command-independent logic in `src/run/create-run.ts` so tests can pass a fake data-access object without
running Commander or a live daemon.

Export a small input/result shape:

```ts
export type CreateRunInput = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  priority?: number;
  now?: Date;
  idSuffix?: string;
};

export type CreateRunResult = {
  runId: string;
  taskId: string;
  stepId: string;
  eventId: string;
  status: 'ready';
};
```

Expose one function:

```ts
export async function createRunWorkflow(
  dataAccess: ControlPlaneDataAccess,
  input: CreateRunInput,
): Promise<CreateRunResult>;
```

This function should:

1. Validate and normalize the input.
2. Call `dataAccess.assertReady()`.
3. Generate row IDs.
4. Write one `task_runs` row.
5. Write one `tasks` row.
6. Write one `steps` row.
7. Write one `events` row.
8. Return the four IDs plus `status: 'ready'`.

Do not add a repository class, domain framework, or custom transaction abstraction. The Plan 0002
`ControlPlaneDataAccess` is the boundary.

**Verify:**

```bash
npm run typecheck
npm test
```

Expected unit tests:

- calls `assertReady()` before writing rows
- creates exactly four rows in the order `task_runs` -> `tasks` -> `steps` -> `events`
- returns the generated IDs
- passes JSON objects to `steps.input`, `steps.output`, and `events.payload` without manual stringification
- does not call any commit/bootstrap API

**Stop conditions:**

- If preserving testability requires importing from `src/cli/...`, stop and move the shared logic into
  `src/run/create-run.ts`.
- If the Plan 0002 API cannot create rows without direct HTTP access, stop and fix Plan 0002 instead of adding
  HTTP code here.

---

## 4. Define IDs, statuses, and row payloads exactly

**Files to create/change:**

- Change `src/run/create-run.ts`
- Change `src/run/create-run.test.ts`

**Implementation notes:**

Use generated but readable row IDs. Do not depend on a database sequence.

Recommended ID algorithm:

```text
slug = lowercased title, non-alphanumeric collapsed to "-", trimmed to 40 chars, fallback "run"
stamp = UTC compact timestamp YYYYMMDDTHHMMSSmmmZ
suffix = first 8 hex chars of crypto.randomUUID(), unless input.idSuffix is supplied by tests

runId   = run_<stamp>_<slug>_<suffix>
taskId  = task_<stamp>_<slug>_<suffix>
stepId  = step_<stamp>_<slug>_<suffix>
eventId = event_<stamp>_<slug>_<suffix>_created
```

`now` and `idSuffix` are injectable for deterministic tests. Production calls should omit both.

Create rows with these fields:

### `task_runs`

```ts
{
  id: runId,
  project_id: '',
  title,
  description,
  status: 'ready',
  repos: [repoRef],
  scope,
  priority,
  created_by: 'cli',
  created_at: nowIso,
  updated_at: nowIso
}
```

### `tasks`

```ts
{
  id: taskId,
  run_id: runId,
  repo_ref: repoRef,
  role_hint: 'architect',
  title,
  status: 'ready',
  depends_on: [],
  scope,
  priority,
  created_at: nowIso,
  updated_at: nowIso
}
```

### `steps`

```ts
{
  id: stepId,
  task_id: taskId,
  run_id: runId,
  role: 'architect',
  kind: 'plan_run',
  status: 'ready',
  input: {
    title,
    description,
    scope,
    repo: repoInfo,
    run_id: runId,
    task_id: taskId
  },
  output: null,
  model_profile: 'standard',
  run_after: '',
  attempt_count: 0,
  max_attempts: 3,
  priority,
  lease_owner: '',
  lease_expires_at: '',
  dead_reason: '',
  created_at: nowIso,
  updated_at: nowIso
}
```

### `events`

```ts
{
  id: eventId,
  run_id: runId,
  task_id: taskId,
  step_id: stepId,
  type: 'run_created',
  payload: {
    source: 'revo run create',
    title,
    description,
    scope,
    repo: repoInfo,
    priority,
    ids: { run_id: runId, task_id: taskId, step_id: stepId }
  },
  actor: 'cli',
  created_at: nowIso
}
```

`repoRef` is the string stored in `task_runs.repos[]` and `tasks.repo_ref`. `repoInfo` is the structured object
stored in JSON-ish fields; Plan 0002 serializes it for `steps.input` and `events.payload`.

Do not seed or validate `roles` or `model_profiles` in this slice. `role: 'architect'` and
`model_profile: 'standard'` are stable placeholders matching the schema vocabulary; later worker/definition
slices will read or seed the versioned tables.

**Verify:**

```bash
npm test
npm run typecheck
```

Expected unit tests:

- generated IDs contain the correct prefixes
- `task_runs.status`, `tasks.status`, and `steps.status` are `ready`
- `steps.kind` is `plan_run`
- `steps.role` is `architect`
- `steps.model_profile` is `standard`
- JSON-ish fields are passed as objects/null, not strings

**Stop conditions:**

- If schema field names differ from `control-plane/bootstrap.config.json`, stop and report the real schema.
- If Plan 0002 enforces a narrower runtime table list that excludes `events`, stop and fix Plan 0002 first.

---

## 5. Validate title, priority, and repo input

**Files to create/change:**

- Change `src/run/create-run.ts`
- Change `src/run/create-run.test.ts`

**Implementation notes:**

Validation rules:

- `title` is required after trimming.
- `repo` is required after trimming.
- `description` defaults to `''`.
- `scope` defaults to `''`.
- `priority` defaults to `0`.
- `priority` must be a finite number. Prefer integers; if a decimal is supplied, reject it instead of rounding.

Repo handling:

- Expand a leading `~/` to `os.homedir()`.
- If the supplied repo value is an existing directory, store its absolute path as `repoRef`.
- If the value starts with `/`, `./`, `../`, or `~/`, treat it as an explicit path. It must exist and be a
  directory.
- Otherwise treat it as a repo name/ref and store the trimmed value unchanged.
- Do not require a Git checkout in this slice. The command creates control-plane state; later runner slices can
  require Git-specific checks.

Store structured repo metadata in JSON-ish fields:

```ts
repoInfo = {
  input: originalRepoArg,
  ref: repoRef,
  mode: existingDirectory ? 'path' : 'name'
}
```

**Verify:**

```bash
npm test
npm run typecheck
```

Expected unit tests:

- missing title fails before writing rows
- missing repo fails before writing rows
- invalid priority fails before writing rows
- existing relative directory becomes an absolute `repoRef`
- explicit missing path fails
- plain repo name is accepted unchanged

**Stop conditions:**

- If test code needs filesystem-heavy setup, use `mkdtemp` under the OS temp directory. Do not depend on this
  repo's parent directory layout.
- If path handling becomes platform-specific, keep the initial implementation POSIX-focused for this macOS
  workspace and report the portability follow-up.

---

## 6. Register `revo run create`

**Files to create/change:**

- Create `src/cli/commands/run.ts`
- Change `src/cli/index.ts`
- Create `src/cli/commands/run.test.ts` if CLI command tests are already practical after Plan 0002

**Implementation notes:**

Follow the existing Commander registration pattern:

```ts
import { Command } from 'commander';

export function registerRun(program: Command): void {
  const run = program.command('run').description('Manage orchestrator runs');

  run
    .command('create')
    .requiredOption('--title <title>', 'Run title')
    .requiredOption('--repo <path-or-name>', 'Repository path or name')
    .option('--description <text>', 'Run description')
    .option('--scope <text>', 'Run scope')
    .option('--priority <n>', 'Run priority', '0')
    .action(createRun);
}
```

Then register it in `src/cli/index.ts`:

```ts
import { registerRun } from './commands/run.js';

registerRun(program);
```

Command behavior:

- Parse priority as a number before calling `createRunWorkflow`.
- Construct the Plan 0002 data-access object with `createControlPlaneDataAccess()`.
- Let `ControlPlaneError` messages surface clearly, but do not print stack traces for expected validation/data
  access errors.
- Exit non-zero on validation or data-access failure.

Expected success output:

```text
created run <runId>
task <taskId>
step <stepId> ready
event <eventId>
status: ready (draft only, not committed)
```

Do not add JSON output, interactive prompts, `--execute`, `--claim`, or `--commit` in this slice.

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- run create --help
```

Expected:

- help shows `--title`, `--repo`, `--description`, `--scope`, and `--priority`
- no daemon is required for `--help`

**Stop conditions:**

- If importing `createControlPlaneDataAccess()` from Plan 0002 introduces a CLI/runtime cycle, stop and report
  the import graph before changing architecture.
- If Commander validation conflicts with service validation, keep service validation authoritative and use
  Commander only for required option presence/help text.

---

## 7. Add a live smoke check for the create-run workflow

**Files to create/change:**

- Create `scripts/smoke-create-run.ts`
- Change `package.json`

**Implementation notes:**

Add a smoke script:

```json
"smoke:create-run": "tsx scripts/smoke-create-run.ts"
```

The smoke should:

1. Spawn `npm run revo -- run create` with a unique title so the real CLI path is exercised.
2. Capture the created IDs.
3. Read back the `task_runs`, `tasks`, `steps`, and `events` rows through Plan 0002 data access.
4. Assert:
   - all four rows exist in draft
   - statuses are `ready`
   - `tasks.run_id` points to the run
   - `steps.task_id` and `steps.run_id` point to the task/run
   - `events.type` is `run_created`
   - `steps.input` and `events.payload` are deserialized objects
5. Fetch the created run from the `head` REST endpoint and confirm it is not visible there.

The smoke must not call any commit command. It can leave draft rows behind.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:create-run
```

Expected:

- smoke exits `0`
- output includes the created run/task/step/event IDs
- the created run is present in `draft`
- the created run is absent from `head`

**Stop conditions:**

- If the control plane already contains old draft rows, use a unique smoke title and generated IDs. Do not reset
  or delete user data unless explicitly asked.
- If you cannot start from a clean local control plane, do not run `bootstrap --commit` again unless you have
  first proven there are no draft runtime rows to commit.
- If verifying absence from `head` requires a REST endpoint that is not available for `head`, report the actual
  limitation and verify the no-commit boundary another way before merging.

---

## 8. Error behavior and partial writes

**Files to create/change:**

- Change `src/run/create-run.ts`
- Change `src/cli/commands/run.ts`
- Change tests added above

**Implementation notes:**

There is no cross-table transaction in this slice. Keep behavior explicit:

- Validate all local inputs before writing any row.
- Call `assertReady()` before writing any row.
- Create rows in this order: run, task, step, event.
- If a later write fails, return/print a clear error and include any IDs already created.
- Do not attempt rollback in this slice.
- Do not retry automatically.

Idempotency is out of scope for Plan 0003. Re-running the command creates a new run with new IDs. Do not dedupe
by title/repo, and do not add a user-supplied `--id` flag yet. Idempotent external effects belong with runner
attempts in later slices.

Map expected errors:

- local validation failure -> concise CLI error, exit non-zero
- Plan 0002 `DAEMON_NOT_RUNNING` -> tell user to run `./bin/revo.js revisium start`
- Plan 0002 `BOOTSTRAP_NOT_APPLIED` or `REST_ENDPOINT_MISSING` -> tell user to run `./bin/revo.js bootstrap --commit`
  only if no runtime rows have been created in this run
- Plan 0002 `ROW_CONFLICT` -> report generated IDs and stop; this should be rare with generated IDs
- other Plan 0002 errors -> print code/status/message and stop

**Verify:**

```bash
npm test
npm run typecheck
```

Expected unit tests:

- validation error writes zero rows
- `assertReady()` failure writes zero rows
- simulated task/step/event failure reports partial IDs
- repeated calls with different suffixes create distinct row IDs

**Stop conditions:**

- If Plan 0002 already provides a transaction-like batch write, do not adopt it silently. Report it and keep this
  slice's command semantics explicit.
- If a bootstrap hint could cause the user to commit rows created earlier in the same failed command, do not
  print that hint. Report the safer remediation instead.

---

## 9. Docs and plans index

**Files to create/change:**

- Change `docs/plans/README.md`

**Implementation notes:**

Add Plan 0003 to the plans index. Do not rewrite roadmap or reference docs in this slice unless the implementation
changes their documented facts.

**Verify:**

```bash
git diff --check
```

**Stop conditions:**

- If the plans index status language no longer matches the repo convention, update only the index row and report
  the broader doc-status follow-up.

---

## 10. Final acceptance test (the whole slice)

Run from a clean local control plane after Plan 0002 has been implemented and this slice is complete. If the
local control plane contains user data, stop and ask before deleting it; do not run `bootstrap --commit` over
existing draft runtime rows.

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
git diff --check
```

Manual CLI verification:

```bash
npm run revo -- run create \
  --title "Smoke create run" \
  --repo . \
  --description "Plan 0003 smoke" \
  --scope "docs-only smoke" \
  --priority 1
```

Expected output shape:

```text
created run <runId>
task <taskId>
step <stepId> ready
event <eventId>
status: ready (draft only, not committed)
```

Then verify draft-only behavior:

```bash
PORT=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(require('node:os').homedir() + '/.revisium-orchestrator/runtime.json', 'utf8')).httpPort)")
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://localhost:${PORT}/endpoint/rest/admin/control-plane/master/draft/tables/task_runs/row/<runId>"
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://localhost:${PORT}/endpoint/rest/admin/control-plane/master/head/tables/task_runs/row/<runId>"
```

Expected:

- draft returns `200`
- head returns `404` or the endpoint's documented not-found status

**Slice is done when:** `revo run create` creates one run, one task, one ready initial step, and one creation
event in draft; IDs are printed; JSON-ish fields round-trip through Plan 0002 helpers; tests and smoke pass; and
no runtime rows are committed.

---

## 11. Report back / open findings (do NOT silently resolve)

When done, report:

1. Files created/changed.
2. Final command syntax.
3. Example output from a successful `revo run create`.
4. Created row IDs and the row fields written to each table.
5. Validation outputs for `npm run typecheck`, `npm test`, `npm run smoke:create-run`, and `git diff --check`.
6. Confirmation that the created run exists in `draft` and is absent from `head`.
7. Any partial-write behavior observed during failure testing.

Open findings to leave for later slices unless they block this one:

- idempotent create-run semantics
- user-supplied run IDs
- worker loop and step claiming
- lease/recovery behavior
- runner/model-provider selection
- role/model_profile seed data
- inbox commands/UI
