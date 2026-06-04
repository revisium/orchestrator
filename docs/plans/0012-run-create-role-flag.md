# Plan 0012 — `revo run create --role <name>` (override the initial step role)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** add a `--role <name>` option to `revo run create` that overrides the initial step's
> role — today hardcoded to `'architect'` in **two** places in `src/run/create-run.ts` (`tasks.role_hint`
> and `steps.role`). Validate the name against the five known roles; default to `'architect'` when omitted.
> Wire the flag through `src/cli/commands/run.ts` → `createRunWorkflow`, and add real unit tests.
>
> **Out of scope (deferred / not this slice):**
> - Per-step or multi-step role assignment, routing policy, or role inference — the loop stays dumb; only the
>   **initial** step's role changes here.
> - Adding `role` to the `events` payload or `steps.input` — keep the existing skeleton shape stable so the
>   current `create-run.test.ts` deepEqual assertions stay green. (If observability of the chosen role is
>   wanted later, that is its own small slice.)
> - Loading the role list dynamically from the `roles` control-plane table. The validation list is a small
>   in-code constant for this slice (see Design decision 2); sourcing it from the seed is a later concern.
> - Numbering: `0009` (inbox + CLI), `0010` (multi-repo), `0011` (GitHub integration) are **reserved by name**
>   in [`../roadmap.md`](../roadmap.md); this CLI slice takes the next free number, `0012`.

---

## Design decisions (made for the implementor — do not relitigate without sign-off)

1. **Validate + default inside `normalizeInput`, not the CLI.** `create-run.ts` already validates `title`,
   `repo`, and `priority` synchronously **before** `assertReady` or any write (proven by the existing test
   *"validates title, repo, and priority before assertReady or writes"*). The role check belongs in the same
   place so an invalid role rejects with **zero rows written** and is unit-testable without commander. The CLI
   layer just passes `options.role` through.
2. **The known-role list is one in-code constant.** Define `KNOWN_ROLES` (and `DEFAULT_ROLE = 'architect'`) in
   `create-run.ts`. The five names — `architect`, `developer`, `reviewer`, `integrator`, `pr-watcher` —
   **must match the seeded `roles` rows** in `control-plane/bootstrap.config.json` (verified: rowIds
   `architect`/`developer`/`reviewer`/`integrator`/`pr-watcher`). Do not invent names not in the seed.
3. **`'architect'` stays the default in two layers, mirroring `--priority`.** `--priority` carries a commander
   default of `'0'` **and** `normalizeInput` defaults `priority ?? 0`. Mirror that exactly: commander default
   `'architect'` (for `--help` discoverability) **and** `normalizeInput` defaults `role` to `DEFAULT_ROLE` as
   the safety net. Both agree, so there is no drift.
4. **Override both hardcoded sites, nothing else.** Replace the literal `'architect'` at
   `create-run.ts:187` (`tasks.role_hint`) and `create-run.ts:202` (`steps.role`) with the normalized role.
   Leave `steps.kind: 'plan_run'`, the event payload, and every other field untouched.

---

## 0. Context you must read first

- `src/run/create-run.ts` — `CreateRunInput` (line 7), `NormalizedInput` (line 27), `normalizeInput` (line 108,
  where `title`/`repo`/`priority` are validated and defaulted), and the two hardcoded `'architect'` literals:
  `tasks.role_hint` (line 187) and `steps.role` (line 202).
- `src/run/create-run.test.ts` — the fake-data-access harness (`createFakeDataAccess` returns `{ access, calls,
  rows }`), `baseInput`, the `byTable(rows, table)` helper, and the existing validation test (lines 149–161)
  that asserts `calls === []` and `rows === []` on bad input. Your new tests mirror these.
- `src/cli/commands/run.ts` — `CreateOptions` type (line 6), `createRun` (line 56, builds the
  `createRunWorkflow` input), and the `run create` command registration with its `.option(...)` chain and the
  `--priority` default-`'0'` precedent (lines 184–190).
- `control-plane/bootstrap.config.json` — seeded `roles` rows (rowIds at lines 579/594/609/624/639) — the
  source of truth the `KNOWN_ROLES` constant must match.

Key facts:

1. `role` (on `steps.role`) is what the worker loads via `loadRole(step.role)` at claim time — setting it is
   what actually routes the initial step to a different agent. `tasks.role_hint` is the task-level companion
   field shown by `revo run`/observability; both are set to `'architect'` today and both must follow `--role`.
2. The existing `create-run.test.ts` asserts the **exact** `steps.input` and `events.payload` objects with
   `deepEqual`. Do **not** add `role` to either object, or those tests break — this slice keeps the skeleton
   shape stable (Out of scope above).

---

## 1. Add `KNOWN_ROLES`, validate, default, and thread the role through the workflow

**Files to change:**

- `src/run/create-run.ts`

**Implementation notes:**

1. Add an optional `role` to `CreateRunInput`:
   ```ts
   export type CreateRunInput = {
     title: string;
     repo: string;
     description?: string;
     scope?: string;
     priority?: number;
     role?: string;        // NEW — defaults to 'architect'
     now?: Date;
     idSuffix?: string;
   };
   ```
2. Near the top-level constants (next to `maxSlugLength`), add the known-role list and default:
   ```ts
   export const KNOWN_ROLES = ['architect', 'developer', 'reviewer', 'integrator', 'pr-watcher'] as const;
   export type KnownRole = (typeof KNOWN_ROLES)[number];
   const DEFAULT_ROLE: KnownRole = 'architect';
   ```
3. Add `role: KnownRole` to the `NormalizedInput` type (line 27 block).
4. In `normalizeInput` (line 108), after the `priority` check and before building the return object, validate
   and default the role — **synchronously, before `assertReady`/writes**:
   ```ts
   const role = (input.role?.trim() || DEFAULT_ROLE) as string;
   if (!(KNOWN_ROLES as readonly string[]).includes(role)) {
     throw new Error(`role must be one of: ${KNOWN_ROLES.join(', ')}`);
   }
   ```
   Include `role: role as KnownRole` in the returned `NormalizedInput`.
5. Replace the two hardcoded literals with `normalized.role`:
   - `tasks` write: `role_hint: normalized.role,` (was `'architect'`, line ~187).
   - `steps` write: `role: normalized.role,` (was `'architect'`, line ~202).

Do not touch `steps.input`, the `events` payload, `kind`, or any other field.

**Verify:**

```bash
npm run typecheck
npm test
```

`typecheck` clean; the existing `create-run.test.ts` suite still passes (default role `'architect'` keeps the
*"writes the exact ready skeleton fields"* test — which asserts `step.role === 'architect'` — green).

**Stop conditions:**

- If the five names in `KNOWN_ROLES` do not match the seeded `roles` rowIds in
  `control-plane/bootstrap.config.json`, **stop and report** — do not silently diverge from the seed.
- Do not move role validation into the CLI layer or make it async/data-driven (Design decisions 1–2).

---

## 2. Add the `--role` option to `revo run create` and pass it through

**Files to change:**

- `src/cli/commands/run.ts`

**Implementation notes:**

1. Add `role: string;` to the `CreateOptions` type (line 6) — commander supplies the default, so it is always
   present.
2. In `createRun` (line 56), thread the option into the workflow input:
   ```ts
   const result = await createRunWorkflow(createControlPlaneDataAccess(), {
     title: options.title,
     repo: options.repo,
     description: options.description,
     scope: options.scope,
     priority: parsePriority(options.priority),
     role: options.role,        // NEW
   });
   ```
3. In `registerRun`, add the option to the `run create` chain (mirror the `--priority` default precedent), e.g.
   after `--scope` and before/around `--priority`:
   ```ts
   .option('--role <name>', 'Initial step role (architect|developer|reviewer|integrator|pr-watcher)', 'architect')
   ```
   Keep the validation in `create-run.ts` (an invalid `--role` surfaces through the existing `createRun`
   catch block as `Error: role must be one of: …` with `process.exitCode = 1`). Do not add a duplicate
   `parse*`-style validator in the CLI.

**Verify:**

```bash
npm run typecheck
npm test
npm run revo -- run create --help
```

`--help` lists `--role <name>` with the allowed names and shows `architect` as the default; it must run without
the daemon. (`run create --help` does not touch the control plane.)

**Stop conditions:**

- Do not register a second source of truth for the default or the validation — the constant and the check live
  in `create-run.ts` (Step 1).

---

## 3. Real unit tests for the override and the validation

**Files to change:**

- `src/run/create-run.test.ts`

**Implementation notes:**

Add tests using the existing harness (`createFakeDataAccess`, `baseInput`, `byTable`). Cover:

1. **Override applies to both fields** — call `createRunWorkflow(access, { ...baseInput, role: 'developer' })`;
   assert `byTable(rows, 'tasks').data.role_hint === 'developer'` and
   `byTable(rows, 'steps').data.role === 'developer'`.
2. **Default when omitted** — `createRunWorkflow(access, { ...baseInput, role: undefined })` (or omit `role`);
   assert both fields are `'architect'`. (This can also lean on the existing skeleton test; add an explicit
   assertion for clarity.)
3. **Unknown role rejects before `assertReady`/writes** — mirror the existing validation test: for
   `{ ...baseInput, role: 'tester' }` (a name **not** in `KNOWN_ROLES`), assert
   `await assert.rejects(() => createRunWorkflow(access, input), /role must be one of/)`, and that `calls === []`
   and `rows === []`. Optionally add `role: 'tester'` as a fourth case to the existing parametrized loop at
   lines 149–161 instead of a standalone test — either is acceptable; do not weaken the `calls`/`rows` empty
   assertions.
4. **Each known role is accepted** (cheap loop) — for every name in `KNOWN_ROLES`, the workflow writes a step
   whose `role` equals that name. (Import `KNOWN_ROLES` from `./create-run.js`.)

**Verify:**

```bash
npm run typecheck
npm test
```

All suites green, including the new cases.

**Stop conditions:**

- Tests must use the in-repo fake data access (no real daemon, no network) — match the existing file.

---

## 4. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
npm run lint:ci
npm test
npm run revo -- run create --help     # lists --role <name>, default architect
git diff --check
```

(`npm run verify` = typecheck + lint:ci + test:cov covers the first three in one command.)

**Slice is done when:** `revo run create --role <name>` overrides both `tasks.role_hint` and `steps.role` for the
initial step; an unknown `--role` is rejected with `role must be one of: …` and writes **zero** rows; omitting
`--role` still produces an `architect` initial step; the known-role list matches the seeded `roles` rows; and the
new unit tests plus the full existing suite pass with no lint warnings — the worker loop and the run skeleton
shape are otherwise unchanged.

---

## 5. Delivery (PR)

When delivering as a PR (per the task input):

- **gh account:** `revisium-io`. **Base:** `master`. **PR body:** empty. **Never force-push.**
- Branch is already `feat/role-flag-via-loop`; commit the three changed files, push, and open the PR with
  `base master` and an empty body.

---

## 6. Report back / open findings

Report:

1. The two override sites changed (`tasks.role_hint`, `steps.role`) and confirmation no other skeleton field
   moved (existing deepEqual tests untouched and green).
2. `KNOWN_ROLES` / `DEFAULT_ROLE` location and that the five names match the seeded `roles` rows.
3. Where validation + default live (one place: `normalizeInput`) and how the CLI surfaces an invalid `--role`.
4. Validation outputs (typecheck / lint:ci / test, `run create --help`) and the PR URL.

Deferred (named or out-of-scope above): role in events/observability payload; dynamic role list from the
`roles` table; routing policy / per-step roles.
