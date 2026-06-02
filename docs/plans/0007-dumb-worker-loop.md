# Plan 0007 - Dumb worker loop with stub runner

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** the dumb worker loop wired end-to-end with a zero-cost stub runner, plus the minimum
> versioned reads and seed data needed to resolve roles/model profiles. **Out of scope:** real Claude Code/Codex
> runner, GitHub integration, inbox UI, multi-worker lease reaping, routing-policy evaluation, and multi-repo
> strategy.

---

## 0. Context you must read first

- `docs/architecture-overview.md` - loop pseudocode and invariants.
- `docs/repo-layer-contract.md` - `loadRole`, `loadModelProfile`, `buildContext`, and lifecycle verbs.
- `docs/runner-contract.md` - `RunAgent` / `AttemptResult` contract.
- `docs/context-budget.md` - what context may include.
- `docs/control-plane-schema.md` - versioned vs runtime boundary.
- `docs/plans/0004-revisium-client-transport.md` - draft/head System API scopes through `@revisium/client`.
- `docs/plans/0006-step-lifecycle-verbs.md` - verbs the loop calls.
- `src/control-plane/steps.ts`
- `src/control-plane/data-access.ts`
- `src/cli/commands/run.ts`
- `control-plane/bootstrap.config.json`

Key facts:

1. The loop is dumb. It must not know which role follows which role.
2. Roles and model profiles are versioned data and are read from committed `head`.
3. Seed roles/profiles are versioned bootstrap rows and are committed by `bootstrap --commit`.
4. Worker id is stable across restarts.
5. The runner is injected. This plan injects the stub; the real runner is a later plan.

---

## 1. Versioned definition reads

**Files to create/change:**

- Create `src/control-plane/definitions.ts`
- Create `src/control-plane/definitions.test.ts`
- Change `src/control-plane/index.ts`

**Implementation notes:**

Use Plan 0004 head access:

```ts
const da = createControlPlaneDataAccess({ revision: 'head' });
```

Expose:

```ts
export type Role = {
  name: string;
  systemPrompt: string;
  modelLevel: 'cheap' | 'standard' | 'deep';
  effort: string;
  runner: 'claude-code' | 'codex';
  allowedTools: string[];
  scopeRules: unknown;
};

export type ModelProfile = {
  level: 'cheap' | 'standard' | 'deep';
  provider: string;
  modelId: string;
  params: unknown;
  costPerInput: number;
  costPerOutput: number;
};

export async function loadRole(name: string): Promise<Role>;
export async function loadModelProfile(level: string): Promise<ModelProfile>;
```

Read rowId = lookup key (`roles/<name>`, `model_profiles/<level>`). Deserialize `scope_rules` and `params`.
Missing rows throw `ROW_NOT_FOUND`.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- If head reads fail because bootstrap seed is absent, continue to step 2. Do not read definitions from draft.

---

## 2. Seed minimal versioned definitions

**Files to change:**

- `control-plane/bootstrap.config.json`

**Implementation notes:**

Add minimal rows for:

- `roles`: `architect`, `developer`
- `model_profiles`: at least `standard`; `cheap` and `deep` may be placeholders for completeness

Rules:

- rowId equals lookup key.
- JSON-ish `scope_rules` and `params` are serialized strings (`"{}"`).
- timestamps are stable strings.
- seed data is versioned, so `bootstrap --commit` is correct here.
- runtime rows are still never committed.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
node --input-type=module -e "import('./dist/control-plane/index.js').then(async m => { console.log(await m.loadRole('architect')); console.log(await m.loadModelProfile('standard')); })"
```

**Stop conditions:**

- If bootstrap rejects row format, stop and report the accepted format. Do not seed by runtime draft writes.

---

## 3. Build context

**Files to create/change:**

- Create `src/worker/build-context.ts`
- Create `src/worker/build-context.test.ts`

**Implementation notes:**

Build a small context string from state, not history:

```ts
export async function buildContext(
  da: ControlPlaneDataAccess,
  step: Step,
  role: Role,
): Promise<string>;
```

Include:

1. role system prompt and scope rules summary.
2. task title/scope/repo for `step.taskId`.
3. prior failed attempt lessons for this step.
4. current `step.input`.

Do not include full transcripts, full logs, or full repo dumps. Leave a `TODO(adr-digest)` marker for ADR
summaries.

**Verify:**

```bash
npm test
npm run typecheck
```

---

## 4. Runner interface and stub runner

**Files to create/change:**

- Create `src/worker/runner.ts`
- Create `src/worker/stub-runner.ts`
- Create `src/worker/stub-runner.test.ts`

**Implementation notes:**

Define the real runner contract now:

```ts
export type NewStepSpec = Omit<NewStep, 'runId'>;

export type AttemptResult = {
  output: unknown;
  artifacts?: unknown;
  nextSteps: NewStepSpec[];
  costs: CostRecord[];
  needsHuman?: boolean;
  lesson?: string;
};

export type RunAgent = (args: {
  role: Role;
  profile: ModelProfile;
  context: string;
  attemptId: string;
  step: Step;
}) => Promise<AttemptResult>;
```

Stub behavior:

- zero tokens and zero cost.
- echo output with role, step id, context size.
- if `role.name === 'architect'`, return one `developer` step.
- if `role.name === 'developer'`, return no next steps.
- `needsHuman` is false.

The architect -> developer behavior lives in the stub runner, not in the loop.

**Verify:**

```bash
npm test
npm run typecheck
```

---

## 5. Worker id and loop

**Files to create/change:**

- Create `src/worker/worker-id.ts`
- Create `src/worker/worker-id.test.ts`
- Create `src/worker/loop.ts`
- Create `src/worker/loop.test.ts`

**Implementation notes:**

`worker-id.ts`:

- read stable id from `${dataDir}/worker-id`.
- generate and persist one if absent.
- allow CLI override.

`runWorker`:

```ts
export type WorkerDeps = {
  da: ControlPlaneDataAccess;
  loadRole: (name: string) => Promise<Role>;
  loadModelProfile: (level: string) => Promise<ModelProfile>;
  runAgent: RunAgent;
};

export type WorkerOptions = {
  workerId: string;
  roles: string[];
  once?: boolean;
  idleSleepMs?: number;
  maxCycles?: number;
};

export async function runWorker(deps: WorkerDeps, opts: WorkerOptions): Promise<void>;
```

Behavior:

1. `recoverInFlight(da, workerId)` once on startup.
2. Claim next step for configured roles.
3. If none: return when `once`, otherwise sleep and continue.
4. Load role and model profile from head.
5. Build context.
6. Start attempt before runner call.
7. Run injected `RunAgent`.
8. On success without `needsHuman`: `writeResult`, then `createSteps`.
9. On `needsHuman`: park as `awaiting_approval` and append event; inbox UI is later.
10. On error: `failStep`.
11. If `once`, return after one processed step.

The loop must not branch on role name to decide next steps.

**Verify:**

```bash
npm test
npm run typecheck
```

Expected tests:

- call order: recover -> claim -> load role/profile -> build context -> startAttempt -> runAgent -> writeResult -> createSteps.
- runner errors call `failStep`.
- `needsHuman` parks and creates no next steps.
- `once` returns on idle.

---

## 6. `revo work`

**Files to create/change:**

- Create `src/cli/commands/work.ts`
- Change `src/cli/index.ts`

**Implementation notes:**

Command:

```bash
revo work [--once] [--roles <csv>] [--worker-id <id>] [--idle-sleep <ms>]
```

Rules:

- `--roles` default: `architect,developer`.
- default runner is the stub in this slice.
- foreground process.
- `SIGINT` stops after current step.
- `--help` works without daemon.
- reuse existing control-plane error hints.

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- work --help
```

---

## 7. Live smoke

**Files to create/change:**

- Create `scripts/smoke-worker-loop.ts`
- Add `"smoke:worker-loop": "tsx scripts/smoke-worker-loop.ts"` to `package.json`

**Implementation notes:**

Smoke:

1. `revo run create` creates an architect step.
2. `revo work --once --worker-id smoke-worker` succeeds the architect step and creates a ready developer step.
3. `revo work --once --worker-id smoke-worker` succeeds the developer step and creates no more steps.
4. Simulate recovery by claim/start without result, then run worker and assert recovery happened on startup.

Zero model cost. No runtime commit.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:worker-loop
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
npm run smoke:worker-loop
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** `revo work` advances a run from architect to developer through runner-returned
`nextSteps`, the loop contains no role-specific workflow branching, head definition reads work, recovery runs on
startup, no model tokens are spent, tests and smoke pass, and no runtime rows are committed.

---

## 9. Report back / open findings

Report:

1. Seeded roles/model profiles.
2. Observed architect -> developer smoke output.
3. Where `nextSteps` originates.
4. Stable worker id path.
5. Validation outputs.
6. Confirmation zero model spend and no runtime commit.

Open findings:

- real Claude Code/Codex runner.
- inbox and approval resolution.
- routing policy evaluation.
- ADR digest in context.
- multi-worker atomic claim and expired lease reaping.
