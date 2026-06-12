# Plan 0010 — Direct unit tests for `parseOwnerRepo`

> **Status: Draft.** Exports the internal `parseOwnerRepo` helper and adds direct unit tests for it.
> **Depends on:** [0005](./0005-real-runners-and-integrator.md) (introduced the helper).
> **Realizes:** fast, direct coverage of GitHub remote-URL parsing, decoupled from the `integrate()` path.

## Problem

`parseOwnerRepo` (`src/runners/integrator.ts:128`) is currently **internal** (not exported). Its behavior is only
covered **indirectly** through full `integrate()` runs:

- `src/runners/integrator.test.ts:534` — `m3` test, comment: *"parseOwnerRepo is not exported, test via the
  integrate path…"*.
- `src/runners/integrator.test.ts:657-740` — `regex hardening` block, comment: *"parseOwnerRepo is internal;
  tested via a minimal integrate() path…"*, using the `makeRemoteOnlyDeps()` fake (line 665).

These indirect tests assert only the boolean outcome (`'needsHuman' in result`) — they cannot assert the **exact
parsed `owner/repo` string**, and they pay the cost of driving `integrate()` (fake git/gh wiring) just to exercise
two regexes. This slice adds direct tests that assert the return value precisely.

## Scope

1. Export `parseOwnerRepo` from `src/runners/integrator.ts`.
2. Add a direct-test block in `src/runners/integrator.test.ts` that calls `parseOwnerRepo` and asserts its exact
   `string | null` return value across positive and negative inputs.

## Non-goals

- Do **not** change the regexes or parsing behavior (`GITHUB_SSH_RE` / `GITHUB_HTTPS_RE`, lines 125-126) — tests
  must lock in *current* behavior, not new behavior.
- Do **not** delete the existing indirect `regex hardening` / `m3` tests — they still assert the `integrate()`
  blocked-vs-ok wiring (a different concern). Leave them as-is.
- No new files; no production-logic changes beyond the `export` keyword.

## Steps

1. **Export the helper.** In `src/runners/integrator.ts:128`, change the declaration
   `function parseOwnerRepo(remoteUrl: string): string | null {` to
   `export function parseOwnerRepo(remoteUrl: string): string | null {`. No other edit; `resolveOwnerRepo`
   (line 136, same file) keeps calling it unchanged.
   **Verify:** `npx tsc --noEmit` exits 0.
   **Stop if:** any other symbol named `parseOwnerRepo` already exists as an export elsewhere
   (`grep -rn 'export.*parseOwnerRepo' src` returns more than this one line) — pause, do not create a duplicate.

2. **Import it in the test.** In `src/runners/integrator.test.ts:10-18`, add `parseOwnerRepo,` to the existing
   named import from `'./integrator.js'` (the block currently imports `integrate, stubIntegrate, preflightLive,
   resolveExecutable, type IntegratorInput, …`).
   **Verify:** `grep -n 'parseOwnerRepo' src/runners/integrator.test.ts` shows the new import line.

3. **Add the direct-test block.** Append a new section at the END of `src/runners/integrator.test.ts` (after the
   last test, currently the `resolveExecutable` block near line 770+). Use the file's existing style —
   `node:test` `test(...)` + `node:assert/strict` `assert.equal(...)`, one assertion per case. Cover, asserting the
   EXACT return value:
   - **SSH positive:** `git@github.com:o/repo` → `'o/repo'`; `git@github.com:o/repo.git` → `'o/repo'`;
     `git@github.com:o/my.repo` → `'o/my.repo'`; dashed/underscored/dotted owner+repo
     (`git@github.com:my-org/my_repo.js` → `'my-org/my_repo.js'`).
   - **HTTPS positive:** `https://github.com/o/repo` → `'o/repo'`; `https://github.com/o/my.repo.git` →
     `'o/my.repo'`; `http://github.com/o/repo` → `'o/repo'` (the regex allows `https?`, line 126).
   - **Trimming:** a value with surrounding whitespace/newline (e.g. `'  git@github.com:o/repo\n'`) → `'o/repo'`
     (confirms the `.trim()` at lines 129/131).
   - **Negative → `null`:** empty string `''`; `git@github.com:o/re po.git` (space); `https://github.com/o/`
     (missing repo segment); `https://github.com/o/repo/tree/main` (trailing path);
     `https://gitlab.com/o/repo` (non-github host); `o/repo` (bare, no scheme/host).
   **Verify:** `npx tsx --test src/runners/integrator.test.ts` — all tests pass, including the new cases.
   **Stop if:** any new case fails because *actual* behavior differs from the expected value above — do NOT change
   the regex to make it pass; instead record the real behavior and flag it (the helper's current behavior is the
   spec for this slice).

## Acceptance

- `parseOwnerRepo` is exported and directly imported by the test.
- `npx tsx --test src/runners/integrator.test.ts` passes with the new direct cases asserting exact `owner/repo`
  strings and `null` rejections.
- `npm test` (whole suite) still passes; `npx tsc --noEmit` clean.
- No production parsing behavior changed; existing indirect tests untouched.
