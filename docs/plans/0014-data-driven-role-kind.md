# Plan 0014 — Data-driven role `kind` (kind-aware role *classification* within the existing route order)

> **Status: Landed** (#67). Stage: post-MVP "method is data" hardening (first slice). The `kind`-aware
> classification this slice added was later subsumed by the full data-driven engine (plan 0015), which removed the
> hardcoded role→phase route entirely.
> **Depends on:** [0009](./0009-playbook-install.md) (playbook install: roles/pipelines as versioned data),
> Group K e2e (`src/e2e/extensibility.e2e.test.ts`) + the self-contained fixture (`src/e2e/fixtures/playbook`).
> **Realizes:** a role declares an optional `kind` in `catalog/roles.json`; that `kind` threads through
> install → role row → `RoleSummary` → `RouteRoleBinding`, and `planRouteExecution` *classifies* each binding by
> `kind` — **falling back to the current hardcoded role-id lists** for known ids (full back-compat). The phase
> **sequence** stays code, and so does the **partition by binding order** (see the hard scope limit below).

## Scope correction — this is CLASSIFICATION, not placement/reordering (read first)

An earlier draft of this plan over-claimed "data-driven placement". That was wrong, and the rest of the plan is
written against the corrected framing below. Re-verified this session against
`src/pipeline/develop-task.workflow.ts`:

- `planRouteExecution` (**line 852**) partitions `route.roleBindings` **by their order in the array**, not by
  `kind`:
  - the post-integrator slice is positional — `afterIntegratorBindings = executableBindings.slice(integratorIndex + 1)`
    (**line 856**);
  - the before/after-developer split is positional — `slice(0, developerIndex)` / `slice(developerIndex + 1)`
    (**lines 863-864**);
  - the phase *labels* are by position — `beforeDeveloperPhase(binding, index)` makes index 0 → `'plan'`
    (**lines 871-874, 940-944**); the after-developer label is review-or-verify (**lines 877-882**).
- Therefore `kind` does **NOT** enable arbitrary placement. It only **re-classifies the phase *type*** a binding
  is treated as **within its existing position** in the route order. Concretely: a `kind:'status'` role that is
  ordered **before** the integrator will **NOT** become a post-integrator role — it never enters
  `afterIntegratorBindings` (that set is `slice(integratorIndex + 1)`), so its `kind` is irrelevant to *where* it
  lands. `kind` changes *how a binding at a given position is classified* (developer vs review vs integrator vs
  status), not *which position it occupies*.
- The role's **order** in the route still comes from the pipeline's `required_roles` order (plus the
  selection-order helpers in the API service — out of scope). So this slice's new capability is precisely: *an
  unknown-id role placed post-integrator **by the pipeline's role order** can be **classified** as a status role
  via `kind` instead of needing its id added to `isReviewRole`.*

**True order-independent placement (declaring "this role runs post-integrator regardless of its position in
`required_roles`") is explicitly a LATER slice** (see Out of scope). It requires `planRouteExecution` to partition
by `kind`/declared-phase instead of by array index — a different, larger change to the route-planning code.

## Why (product vision, this slice only)

Vision (verbatim intent): *nothing should be hardcoded — neither roles nor pipelines come from code; everything is
filled from data, with at most a set of built-in/system roles/scripts a pipeline may use.* This plan is **step 1**:
the **classification** of a role (which phase *type* it is treated as, given its position) becomes **data**. It does
**not** make the phase sequence itself data, and it does **not** make role *placement/order* data — both stay code,
per the invariant and the scope correction above.

This is exactly the "method is data" line the architecture draws:

- `docs/architecture-overview.md:67` — *"The pipeline shape (**MVP: code**; post-MVP: data) | The DBOS
  workflow(s) + the thin engine layer"* (re-read this session; the shape/sequence stays code).
- `docs/architecture-overview.md:77-78` — *"A new *way to do something* is a plugin; a new *thing to do* is
  data. Crossing that line dissolves invariant #1."* Adding a role and saying *what kind of step it is* is a data
  edit.
- `docs/adr/0001-execution-engine-and-host.md:73` — lists *workflow-as-data* as a later (post-MVP) deliverable.

Today, **roles are data** but their **phase classification is code**: `planRouteExecution` classifies each binding
by hardcoded role-**id** lists. Embedding a brand-new role into a pipeline phase therefore requires a code edit to
those lists. This slice removes that for the classification axis only.

## Current state (verified this session — files opened + lines quoted)

All references below were re-opened in this planning session; line numbers are current as of this write.

1. **Pipeline shape is code; partition is by binding ORDER; classification is by hardcoded role-id.**
   `src/pipeline/develop-task.workflow.ts`:
   - `planRouteExecution(route)` at **line 852** partitions `route.roleBindings` into the phases captured by
     `RouteExecutionPlan` (**lines 844-850**): `beforeDeveloper`, `developer?`, `afterDeveloper`, `integrator?`,
     `postIntegratorStatus`. The partition is **positional**: post-integrator =
     `executableBindings.slice(integratorIndex + 1)` (**line 856**); before/after developer =
     `slice(0, developerIndex)` / `slice(developerIndex + 1)` (**lines 863-864**). `RouteExecutionStep.phase`
     (**lines 838-842**) is one of `'plan' | 'prepare' | 'review' | 'verify' | 'status'`, assigned by position
     (**lines 871-882, 940-944**). **`kind` changes only the classifier verdict, never the slice boundaries.**
   - Classifiers (all take a `RouteRoleBinding` and switch on `binding.roleId`):
     - `isDeveloperRole` **line 946**: `['developer','developer-backend','developer-frontend','knowledge-engineer'].includes(binding.roleId)`.
     - `isOrchestrationRole` **line 950**: `binding.roleId === 'orchestrator'`.
     - `isReviewRole` **line 954**: `['reviewer','watcher','pr-watcher','deploy-watcher','qa-backend','qa-frontend'].includes(binding.roleId)`.
     - `isIntegratorRole` **line 958**: `binding.roleId === 'integrator' || runnerUsesRealIntegrator(binding.resolvedRunnerId)`.
       Note the **runner clause**: `runnerUsesRealIntegrator` (`route-contract.ts:118-120`) is true for
       `revo-integrator`/`revo-merger`. So a binding whose **resolved runner actually performs the merge** is the
       integrator irrespective of id — this is load-bearing and must survive the `kind` rewrite (see D7).
     - `isPostIntegratorStatusRole` **line 962**: `return isReviewRole(binding);`.
   - `beforeDeveloperPhase` **line 940**: index 0 → `'plan'`; else `isReviewRole` → `'review'`; else `'prepare'`.
   - `validatePostIntegratorBindings` **lines 932-938**: any post-integrator binding for which
     `!isPostIntegratorStatusRole(binding)` throws
     `ROUTE_UNSUPPORTED: pipeline … has executable roles after integrator: <ids>`.
2. **The binding contract carries no `kind`.** `src/pipeline/route-contract.ts:7-14` —
   `RouteRoleBinding = { roleId; rowId; modelLevel; runnerId; resolvedRunnerId; runnerSource }`.
   `RouteDecision` is **lines 16-29** (carries `roleBindings: RouteRoleBinding[]`).
3. **Roles are data; loaded as `RoleSummary` — which lives in `roles.service.ts`.**
   `src/revisium/roles.service.ts` (**NOT** `playbooks.service.ts`):
   - `RoleSummary` **lines 6-15**: `{ id; name; modelLevel; runner; surface; rights; playbookId; playbookRoleId }`.
   - `listRoles()` **lines 42-59** maps each role row's `data` into `RoleSummary` via `str(data.<field>)`.
   - This is the source of the `RouteRoleBinding` field values; the threading hop is
     `roles.service.ts (RoleSummary) → RouteRoleBinding`.
4. **Bindings are built in the API service.** `src/task-control-plane/task-control-plane-api.service.ts`:
   - It imports `RoleSummary` from `'../revisium/roles.service.js'` (**line 23**:
     `import { RolesService, type RoleSummary } from '../revisium/roles.service.js';`).
   - `resolveRouteRoles(...)` **lines 735-779** loads roles (`this.roles.listRoles()` filtered by playbook,
     **line 740**), builds `byPlaybookRole` (**line 741**), and constructs each `RouteRoleBinding` at
     **lines 764-778** from the `RoleSummary` (`const role = byPlaybookRole.get(roleId) as RoleSummary;` **line 765**).
   - A **second** cluster of hardcoded role-id placement logic lives here too: `isPreDeveloperAnalysisRole`
     **line 179** (`['analyst','architect','reviewer','knowledge-engineer']`) and
     `insertBeforeFirstDeveloperRole` **line 183** (developer-id list). **This is selection ORDER, not phase
     classification — OUT OF SCOPE for this slice** (see Non-goals).
5. **Catalog → row mapping.** `src/playbook/catalog-loader.ts`:
   - `RoleCatalogRecord` **lines 6-14**: `{ id; path; surface; rights; defaultModelLevel; runnerId; wrappers }`.
   - `parseRole(...)` **lines 111-139** builds it from the JSON record (returns object **lines 130-138**).
   `src/playbook/import-mapper.ts`:
   - `mapRole(...)` **lines 134-176** writes the role row `data` (object **lines 149-174**: `id`, `name`,
     `model_level`, `runner`, `runner_id`, `scope_rules` (JSON string, **lines 158-164**), `playbook_role_id`,
     `surface`, `rights`, etc.).
6. **Schema version is `2`.** `src/playbook/manifest.ts:6` —
   `export const SUPPORTED_PLAYBOOK_SCHEMA_VERSION = 2;`. `parsePlaybookManifest` **lines 38-60** rejects any
   other `schema_version` with `PLAYBOOK_UNSUPPORTED_SCHEMA`.
7. **Fixture proves a RECOGNIZED embedded role.** `src/e2e/fixtures/playbook/catalog/roles.json` declares
   `pr-watcher` (**lines 170-177**, `runner_id: claude-code`, no `kind`). `feature-pr-watch`
   (`src/e2e/fixtures/playbook/catalog/pipelines.json:354-412`) lists it post-integrator in `required_roles`
   (**lines 361-368**). `pr-watcher` **is in** `isReviewRole`'s list → recognized today.
   Group K (`src/e2e/extensibility.e2e.test.ts`, **lines 65-97**) pins K1/K2/K3.
8. **No `kind` concept exists yet.** `grep` over `src/pipeline`, `src/playbook`, `src/task-control-plane`,
   `src/revisium`, `src/control-plane/definitions.ts` for `kind`/`role_kind`/`roleKind`/`phaseKind` finds only
   the unrelated inbox `item.kind` and the e2e `RoleBehavior.kind` discriminated unions — **the feature does not
   already exist** (confirmed this session).

## Invariants this slice must NOT break

> **1. The pipeline phase SEQUENCE is code** (`architecture-overview.md:67`). The list and order of phases
> (`beforeDeveloper → developer → afterDeveloper → integrator → postIntegratorStatus`) and the loop semantics
> stay exactly as coded in `planRouteExecution`.
>
> **2. The partition of bindings into phases is POSITIONAL (by route order).** `planRouteExecution` slices
> `route.roleBindings` by index (post-integrator = `slice(integratorIndex + 1)`, etc.). This plan does **not**
> touch those slice boundaries. `kind` only changes the **classifier verdict** applied to a binding **at its
> existing position** — it never moves a binding between slices.

## The change (one sentence)

A role may declare an optional `kind` (`developer | review | status | integrator`) in `catalog/roles.json`; thread
it `catalog → role row → RoleSummary → RouteRoleBinding`; the `planRouteExecution` classifiers read `binding.kind`
and **fall back to the existing hardcoded role-id lists when `kind` is absent**, so every known role keeps its
current classification and `validatePostIntegratorBindings` additionally accepts an unknown-id role **already
positioned after the integrator** whose `kind` is `status`.

## Design decisions (do not relitigate)

- **D1. `kind` lives on the ROLE, not the pipeline role-ref.** The catalog already separates role definitions
  (`catalog/roles.json`) from pipeline role *references* (`required_roles` etc.). Classification is an intrinsic
  property of a role's behavior (a "review" role reviews wherever embedded), and the binding already carries
  role-derived fields (`modelLevel`, `runner`). Putting `kind` on the pipeline ref would require a new ref shape
  and a second resolution path. (Per-pipeline placement *override* is a deliberate later option — see Out of scope
  + Open questions.)
- **D2. `kind` is OPTIONAL with role-id fallback — NO `schema_version` bump for this slice.** Absent `kind` ⇒ the
  current hardcoded id lists decide classification (so `schema_version` stays `2`; existing playbooks install
  unchanged). Adding an optional field is forward-compatible **between the host and the fixture playbook that ship
  together** (a reader that doesn't know `kind` ignores it). Bumping the schema would force every installed
  playbook to re-declare. **Caveat (see Compatibility):** a playbook that *depends* on `kind` (an unknown-id role
  positioned post-integrator) is **not** forward-compatible with an older host — it would install, then fail
  `ROUTE_UNSUPPORTED` at route time. A capability gate for that case is an explicit follow-up, not this slice.
- **D3. Closed `kind` vocabulary `developer | review | status | integrator`, validated at load.**
  An unknown/unrecognized `kind` string in the catalog is a `PLAYBOOK_INVALID_CATALOG` error at install — fail
  fast at install-time, exactly like the `MODEL_LEVELS` check (`catalog-loader.ts:39, 115-117`), **not** at route
  time. Mapping: `status` ⇒ classified into the `postIntegratorStatus` set **if positioned after the integrator**;
  `review` ⇒ the existing review classification; `integrator` ⇒ `isIntegratorRole` (subject to the runner-wins
  override in D7); `developer` ⇒ the single developer slot. **`planner` is intentionally OUT of the v1
  vocabulary** (it is inert today — see Q3).
- **D4. Explicit `kind` on an UNRECOGNIZED id WINS; explicit `kind` that CONFLICTS with a recognized built-in id
  is REJECTED at load.** Two sub-cases:
  - *Unknown id + `kind`* (the new capability, e.g. `pr-poller` + `kind:'status'`): the `kind` decides
    classification. This is the whole point of the slice.
  - *Recognized built-in id + a `kind` that disagrees with its historical id-class*: **reject at load** in
    `parseRole` with `PLAYBOOK_INVALID_CATALOG`. The recognized built-ins are: `orchestrator`; the developer ids
    (`developer`, `developer-backend`, `developer-frontend`, `knowledge-engineer`); the review ids (`reviewer`,
    `watcher`, `pr-watcher`, `deploy-watcher`, `qa-backend`, `qa-frontend`); and the integrator id (`integrator`).
    A built-in id carrying a *matching* `kind` (e.g. `reviewer` + `kind:'review'`) is allowed (it is a no-op
    relative to the id fallback). A built-in id carrying a *non-matching* `kind` (e.g. `developer` + `kind:'review'`)
    is a load error. Rationale: silently honoring it is a foot-gun (one careless `kind` mis-routes a real
    pipeline) and merely warning is not enough for an install-time source of truth. **Repurposing a built-in id is
    a later, explicit capability**, not a side effect of this field. (Reversal of the earlier draft, which
    silently honored the conflict — see Q1.)
- **D5. Threading mechanism = one new optional string field at each hop.** `RoleCatalogRecord.kind?`,
  role row `data.kind` (top-level only — see D6), `RoleSummary.kind?`, `RouteRoleBinding.kind?`. No new tables, no
  new transport, no `RouteDecision` shape change beyond the binding field.
- **D6. `kind` is persisted as a single top-level `data.kind` field — deliberately NOT duplicated into
  `scope_rules`.** The role row already has a `scope_rules` JSON string (`import-mapper.ts:158-164`); `kind` is a
  routing/classification axis, not a scope concern, so it stays a top-level column only. This is intentional: do
  **not** "for consistency" also write it into `scope_rules` — that JSON string feeds the catalog hash
  (`import-mapper.test.ts`), and adding a field there would change the hash for kind-bearing roles for no benefit.
- **D7. A role bound to a REAL-INTEGRATOR runner is the integrator regardless of `kind` (runner-wins).**
  `isIntegratorRole` today is `roleId === 'integrator' || runnerUsesRealIntegrator(resolvedRunnerId)`
  (`develop-task.workflow.ts:958-959`; `runnerUsesRealIntegrator` ⇒ `revo-integrator`/`revo-merger`,
  `route-contract.ts:118-120`). A role whose resolved runner *actually performs the merge* MUST be treated as the
  integrator even if its `kind` says otherwise — `kind` cannot demote a role that mechanically does the merge, and
  doing so would let a pipeline route past the integrator gate. So the integrator classifier keeps the runner
  clause as an **unconditional override** of `kind`. Pinned by a unit test (Step 6).
- **D8. The classifiers become `kind`-first, id-fallback** — a single private helper
  `bindingMatchesKind(binding, kind, idFallback)` so the developer/review/status sites stay consistent and the
  fallback is expressed once. The integrator classifier is special-cased per D7 (runner clause wins over `kind`).

## Out of scope (explicit — these are LATER plans / follow-ups)

- **True order-independent placement** — making `kind` (or a declared phase) actually *move* a role into a phase
  regardless of its index in `required_roles`. That requires `planRouteExecution` to partition by
  `kind`/declared-phase instead of by array position (the positional slices at
  `develop-task.workflow.ts:856, 863-864`). This slice does **classification within the existing order** only; the
  "place anywhere" capability is a separate, larger plan. (This is the single most important scope boundary —
  callers must not mistake this slice for arbitrary placement.)
- Making the phase **sequence** itself data-driven (the phase list/loop in `planRouteExecution` /
  `RouteExecutionPlan`). The shape stays code.
- The selection-**order** helpers in the API service (`isPreDeveloperAnalysisRole` /
  `insertBeforeFirstDeveloperRole`, `task-control-plane-api.service.ts:179-188`). They decide *insertion order of
  alternative roles*, not phase classification; a separate slice can move them to data.
- A **`planner` kind** — deferred until it has a real phase effect (see Q3). Adding it now would declare a
  vocabulary value that changes nothing (the `'plan'` label is purely positional, index-0 only).
- Runner / script-kind unification (a "script" `kind` distinct from agent roles, runner taxonomy).
- PR-poller → merge-gate wiring (the `nextAction: ready_for_merge_gate` path from plan 0013).
- Per-pipeline placement override (a `kind` on the pipeline role-ref).
- Any `schema_version` bump or migration of already-installed role rows.
- **A capability gate for kind-DEPENDENT playbooks shipped to mixed hosts** (see Compatibility). When a playbook
  whose correctness *depends* on `role_kind` (an unknown-id post-integrator role) must install on hosts that may
  predate this feature, add an explicit capability declaration — e.g. `requires_features: ['role_kind']` in the
  manifest, or a `schema_version: 3` with host-side support — so an old host *rejects at install* instead of
  installing then failing `ROUTE_UNSUPPORTED` at route time. Not needed for this slice (host + fixture ship
  together), but required before kind-dependent playbooks ship externally.

## Steps

Each step lists exact files, a **Verify** command, and **Stop if** conditions. Run from repo root
(`/Users/anton/projects/revisium/agent-orchestrator`). Node `>=24.11.1 <25`.

### 1. Define the `kind` vocabulary + carry it on the binding contract

**File:** `src/pipeline/route-contract.ts`.
- Add an exported type + const for the closed v1 vocabulary (NO `planner` — see D3/Q3):
  `export const ROLE_KINDS = ['developer','review','status','integrator'] as const;`
  `export type RoleKind = (typeof ROLE_KINDS)[number];`
- Add `kind?: RoleKind;` to `RouteRoleBinding` (currently **lines 7-14**).

**Verify:** `pnpm run typecheck` exits 0.
**Stop if:** any existing `RouteRoleBinding` literal elsewhere fails to typecheck *for a reason other than a
missing optional field* (an optional field must not break existing literals). `grep -rn 'RouteRoleBinding' src`
should show **4** files: `src/pipeline/route-contract.ts` (the definition site), `develop-task.workflow.ts`,
`develop-task.workflow.test.ts`, and `task-control-plane-api.service.ts` (confirmed this session).

### 2. Parse + validate `kind` in the catalog loader (incl. built-in-conflict rejection)

**File:** `src/playbook/catalog-loader.ts`.
- Add `kind?: RoleKind;` (import `RoleKind`/`ROLE_KINDS` from `../pipeline/route-contract.js`) to
  `RoleCatalogRecord` (**lines 6-14**).
- In `parseRole` (**lines 111-139**), read an **optional** `kind` field, following the `MODEL_LEVELS` pattern
  (**lines 39, 114-117**). Define a `const ROLE_KIND_SET = new Set(ROLE_KINDS)`:
  1. **Absent** (`record.kind === undefined`): leave unset.
  2. **Unknown value** (a non-empty string NOT in `ROLE_KIND_SET`, or a non-string): throw
     `PlaybookError('PLAYBOOK_INVALID_CATALOG', \`${context}.kind is invalid: ${String(record.kind)}\`)` — fail
     fast at install (D3).
  3. **Conflicting built-in id** (D4): if `record.id` is a recognized built-in **and** the supplied valid `kind`
     disagrees with that id's historical class, throw
     `PlaybookError('PLAYBOOK_INVALID_CATALOG', \`${context}.kind ${kind} conflicts with built-in role id ${id}\`)`.
     Encode the built-in→kind map **once, character-identical to the workflow classifiers** (re-grep
     `develop-task.workflow.ts:946-959` before writing; do not paraphrase the lists):
     - `orchestrator` → (orchestration; any `kind` conflicts — it is filtered out of execution entirely, so a
       routing `kind` is meaningless on it);
     - `developer`, `developer-backend`, `developer-frontend`, `knowledge-engineer` → `developer`;
     - `reviewer`, `watcher`, `pr-watcher`, `deploy-watcher`, `qa-backend`, `qa-frontend` → `review`;
     - `integrator` → `integrator`.
     A *matching* `kind` on a built-in id (e.g. `reviewer` + `kind:'review'`) is allowed (no-op vs the fallback);
     a *non-matching* `kind` is the load error.
  4. **Valid + non-built-in id** (the new capability): set `kind`.
- Add `kind` to the returned object (**lines 130-138**), only when set.

**Verify:** `pnpm exec tsx --test src/playbook/catalog-loader.test.ts` — all existing cases pass. Add cases:
- unknown `kind` (`"wizard"`) throws `/kind is invalid/`;
- a valid `kind` (`"status"`) on a NON-built-in id (e.g. `pr-poller`) loads onto `catalogs.roles[i].kind`;
- a built-in id with a CONFLICTING `kind` (`developer` + `kind:'review'`) throws `/conflicts with built-in role id/`;
- a built-in id with a MATCHING `kind` (`reviewer` + `kind:'review'`) loads without error.
**Stop if:** any existing catalog-loader test fails (the field is optional; absent-`kind` records must parse
exactly as before), or the built-in id→kind map diverges character-by-character from the workflow classifier
lists.

### 3. Persist `kind` into the role row on install

**File:** `src/playbook/import-mapper.ts`.
- In `mapRole` (**lines 134-176**), add `kind: role.kind` to the role row `data` object (**lines 149-174**) —
  only when defined (omit the key when `role.kind === undefined`, so existing snapshot/hash assertions for
  kind-less roles are unaffected; mirror how the row already conditionally shapes data).
- **Note (intentional, do not "fix" later):** `kind` is written as a **top-level `data.kind` field only** — it is
  deliberately **NOT** also duplicated into the `scope_rules` JSON (**lines 158-164**). `scope_rules` feeds the
  catalog hash; adding `kind` there would change the hash for every kind-bearing role for no functional gain. A
  future "consistency" PR that mirrors `kind` into `scope_rules` is unwanted — `data.kind` is the single source
  (D6).

**Verify:** `pnpm exec tsx --test src/playbook/import-mapper.test.ts` — existing cases pass unchanged. Add one
case: a `RoleCatalogRecord` with `kind: 'status'` produces a row whose `data.kind === 'status'`; a record without
`kind` produces a row where `'kind' in data === false`.
**Stop if:** the catalog-hash assertion (`import-mapper.test.ts:89`) changes for a **kind-less** role — it must
not (conditional omission keeps the serialized shape identical for existing fixtures).

### 4. Surface `kind` on `RoleSummary` (+ cover `listRoles` mapping)

**File:** `src/revisium/roles.service.ts` (this is where `RoleSummary` lives — **NOT** `playbooks.service.ts`).
- Add `kind?: RoleKind;` to `RoleSummary` (**lines 6-15**), importing `RoleKind`/`ROLE_KINDS` from
  `../pipeline/route-contract.js`.
- In `listRoles()` (**lines 42-59**), read `data.kind` with three branches (the row is the **persisted source of
  truth** — a corrupted value must be loud, NOT silently normalized to an id-fallback):
  1. **Absent / empty** (`str(data.kind) === ''`): leave `kind` undefined (the row predates the field; id-fallback
     in the workflow applies — this is the normal back-compat path).
  2. **Non-empty AND a valid vocab value** (`ROLE_KINDS` includes it): set `kind`.
  3. **Non-empty AND invalid** (a non-empty `data.kind` not in `ROLE_KINDS`): **throw** a validation error (reuse
     `ControlPlaneError('VALIDATION_FAILURE', \`role ${node.id} has invalid kind: ${...}\`)`, matching how this
     service already propagates `VALIDATION_FAILURE`). Rationale (point 6): the loader already rejects bad `kind`
     at install, so a non-empty-but-invalid persisted value means the source-of-truth row is corrupt — surface it
     loudly, do **not** quietly fall back to id-based classification (which would mask a corrupted catalog).

**File:** `src/revisium/roles.service.test.ts` (**confirmed to EXIST** this session; it currently covers only
`loadRole`/`loadModelProfile`/mode — **no `listRoles` coverage at all**). Add `listRoles` cases via a fake head
transport whose `listRows('roles', …)` returns crafted rows:
- a row with `data.kind === 'status'` → `RoleSummary.kind === 'status'`;
- a row with no `kind` → `RoleSummary.kind === undefined`;
- a row with a non-empty invalid `data.kind` (e.g. `'staus'`) → `listRoles()` rejects with `VALIDATION_FAILURE`
  (proves the loud-surface rule, not silent id-fallback).
(The existing `fakeHeadTransport` helper returns `{ edges: [] }` from `listRows`; extend it to return seeded edges
for these cases.)

**Verify:** `pnpm run typecheck` exits 0; `pnpm exec tsx --test src/revisium/roles.service.test.ts` — existing
cases plus the new `listRoles` cases pass.
**Stop if:** `RoleSummary` becomes a *required* `kind` field anywhere — the field stays optional so every existing
fake `listRoles()` in `task-control-plane-api.service.test.ts` (e.g. **lines 540-573**) keeps compiling.

### 5. Thread `kind` into the binding in `resolveRouteRoles`

**File:** `src/task-control-plane/task-control-plane-api.service.ts`.
- In the binding constructor (**lines 764-778**), add `kind: role.kind` to the returned `RouteRoleBinding` (only
  when defined, or rely on `undefined` being valid for the optional field — prefer spreading
  `...(role.kind ? { kind: role.kind } : {})` to keep the object shape clean).

**Verify:** `pnpm exec tsx --test src/task-control-plane/task-control-plane-api.service.test.ts` — all existing
route tests pass (e.g. "binds every required playbook role in order" **line 537**). Add one case: a fake
`listRoles()` returning a role with `kind: 'status'` yields a `route.roleBindings[i].kind === 'status'`; a role
without `kind` yields `kind === undefined`.
**Stop if:** any existing simulateRoute test changes its asserted `roleBindings` shape for kind-less roles.

### 6. Make `planRouteExecution` classifiers `kind`-first with id fallback (integrator special-cased)

**File:** `src/pipeline/develop-task.workflow.ts`.
- Add one private helper near the classifiers (after **line 944**):
  ```ts
  function bindingMatchesKind(binding: RouteRoleBinding, kind: RoleKind, idFallback: boolean): boolean {
    if (binding.kind) return binding.kind === kind;   // explicit kind decides
    return idFallback;                                 // back-compat: hardcoded id lists
  }
  ```
- Rewrite the classifiers (**lines 946-964**) to delegate, preserving the *exact* current id lists as the
  `idFallback` argument (re-grep `lines 946-959` first; the lists must be character-identical):
  - `isDeveloperRole`: `bindingMatchesKind(binding, 'developer', ['developer','developer-backend','developer-frontend','knowledge-engineer'].includes(binding.roleId))`.
  - `isReviewRole`: `bindingMatchesKind(binding, 'review', ['reviewer','watcher','pr-watcher','deploy-watcher','qa-backend','qa-frontend'].includes(binding.roleId))`.
  - `isIntegratorRole` (**SPECIAL-CASED — D7, runner-wins**): the real-integrator runner clause is an
    **unconditional** override of `kind`; a role that mechanically performs the merge is the integrator even if
    `kind` says otherwise. Write it so the runner clause is checked first, e.g.:
    ```ts
    function isIntegratorRole(binding: RouteRoleBinding): boolean {
      if (runnerUsesRealIntegrator(binding.resolvedRunnerId)) return true; // runner wins over kind (D7)
      return bindingMatchesKind(binding, 'integrator', binding.roleId === 'integrator');
    }
    ```
    (Do **not** fold the runner clause into the `idFallback` arg — that would let an explicit non-integrator
    `kind` suppress it, which D7 forbids.)
  - `isPostIntegratorStatusRole`: `return bindingMatchesKind(binding, 'status', isReviewRole(binding));`. This is
    correct as-is: if `binding.kind` is set, the helper returns `binding.kind === 'status'` (so a `kind:'review'`
    role is **not** a status role — it short-circuits on the explicit kind, no leak); if `kind` is absent it falls
    back to `isReviewRole`. (No extra guard is needed — the one-liner already short-circuits on explicit kind.)
  - `isOrchestrationRole` (**line 950**): leave as `binding.roleId === 'orchestrator'` for this slice (orchestration
    is filtered out entirely at **line 854**; there is no orchestration `kind` in the vocabulary, and the loader
    rejects any `kind` on the `orchestrator` id — D4).
  - `beforeDeveloperPhase` (**line 940**): **unchanged.** It already calls `isReviewRole` (now kind-aware). The
    index-0 `'plan'` label is purely positional and is out of scope for `kind` (no `planner` kind in v1).
- `validatePostIntegratorBindings` (**lines 932-938**): no code change needed — it already rejects any
  post-integrator binding where `!isPostIntegratorStatusRole(binding)`, and that predicate now accepts a
  `kind: 'status'` role with an **unknown id** *that is already positioned after the integrator*. (Add a code
  comment noting the new acceptance path, and that a `kind:'status'` role positioned *before* the integrator is
  not affected — it never enters `afterIntegratorBindings`.)

**Verify:** `pnpm exec tsx --test src/pipeline/develop-task.workflow.test.ts` — ALL existing tests pass, including
"unsupported route shape fails…" (**line 1060**, `developer-backend` after integrator still throws
`ROUTE_UNSUPPORTED`) and the canonical feature-development tests (**lines 909, 956, 1002**). Then add unit cases
using `makeRoute`/`binding` (**lines 376-402**) — extend `binding(...)` to accept an optional `kind` arg:
  - a binding with **unknown id** `'pr-poller'` + `kind: 'status'` **placed after the integrator** routes into
    `postIntegratorStatus` and does **not** throw;
  - the same unknown id `'pr-poller'` **without** `kind` after the integrator **throws** `ROUTE_UNSUPPORTED`
    (proves the fallback still rejects unknown ids);
  - **D7 pin:** a binding with `kind: 'status'` (or any non-integrator kind) whose `resolvedRunnerId` is
    `revo-integrator` is still classified as the integrator (`isIntegratorRole` true; it occupies the integrator
    slot), proving runner-wins-over-kind;
  - a binding carrying `kind: 'review'` is classified as review (proves `bindingMatchesKind` honors explicit
    kind). **Note in the test comment:** the *conflicting built-in id* case (e.g. `developer` + `kind:'review'`)
    cannot arise from a real install because the loader rejects it (Step 2 / D4); this unit test pins only the
    classifier's raw kind-first behavior on an arbitrary binding.
**Stop if:** any pre-existing workflow test changes outcome. The id lists used as `idFallback` MUST be
character-identical to the originals (re-grep the originals before editing; do not paraphrase).

### 7. Extend the e2e fixture with an UNRECOGNIZED-id, explicit-`kind` embedded role

This is the **new capability** the safety net must cover (Group K only proves a *recognized* id today).

**Files:**
- `src/e2e/fixtures/playbook/catalog/roles.json`: add ONE role with an id **not** in any hardcoded list, e.g.
  `{"id":"pr-poller","path":"stub.md","surface":"any","rights":"read-only","default_model_level":"cheap","runner_id":"claude-code","kind":"status"}`.
  (`pr-poller` is not in `isReviewRole`/`isDeveloperRole`/`isIntegratorRole`, and there is no `RUNTIME_NAME_MAP`
  entry for it in `import-mapper.ts:23-32`, so `runtimeRoleName('pr-poller') === 'pr-poller'` and the e2e agent
  dispatches on that logical role via `role.playbookRoleId ?? role.name`, `agents.ts:67/89`.)
- `src/e2e/fixtures/playbook/catalog/pipelines.json`: add ONE pipeline, e.g. `feature-pr-poll`, that mirrors
  `feature-pr-watch` (**lines 354-412**) but lists `pr-poller` post-integrator instead of `pr-watcher` in
  `required_roles` (`orchestrator, analyst, reviewer, developer, integrator, pr-poller`), same `route_gates`
  (`task spec approval`, `merge approval`) and a benign `execution_policy`.
- `src/e2e/extensibility.e2e.test.ts`: add K4/K5 mirroring K1/K3 (**lines 65-97**) but for the
  **unrecognized-id** role. **The capability proven is: an unknown-id role, positioned post-integrator by the
  pipeline's `required_roles` order, is CLASSIFIED as a status role via its `kind` — without its id being added to
  any code list.**
  - **K4** (run): start the `feature-pr-poll` run with `STUB_INTEGRATOR` (**line 30**), `approveUntilTerminal`,
    assert `state === 'completed'`, `integrate_succeeded` + `run_completed` events present, and
    `executedRoles(...)` includes `'pr-poller'`.
    **Event-order assertion (point 7):** the events API exposes insertion-ordered events with a `payload.stepKey`
    on `step_succeeded` (see `assertReplayIdempotent`, `assertions.ts:95-98`). Assert `integrate_succeeded`
    appears **before** pr-poller's `step_succeeded` (the event whose `payload.stepKey === 'pr-poller'`) in the
    `getRunEvents({ runId, limit: 50 })` list — proving the status role ran *after* the integrator at runtime, not
    merely that both events are present. (If pr-poller's step is not emitted as `step_succeeded` with that
    stepKey, fall back to asserting the index of `integrate_succeeded` precedes the first event referencing
    `pr-poller`; verify the actual event shape against the kit before finalizing the matcher.)
  - **K5** (routing — RIGOR FIX, point 7): the current K3 only checks `route.roles` order (the required-role-id
    order), which would pass even if `kind` never reached the binding. K5 must instead prove `kind` **threads to
    the `RouteRoleBinding`**. Cast the `simulateRoute` return to expose `roleBindings` (it does — see
    `resolveRouteDecision`, `task-control-plane-api.service.ts:692-705`, which returns `roleBindings`) and assert:
    ```ts
    const route = (await h.api.simulateRoute({ title: 'route', pipeline: PIPELINE_POLL })) as unknown as {
      pipelineId: string; roles: string[];
      roleBindings: Array<{ roleId: string; kind?: string }>;
    };
    assert.equal(route.roleBindings.find((b) => b.roleId === 'pr-poller')?.kind, 'status'); // kind threaded to binding
    assert.ok(route.roles.indexOf('pr-poller') > route.roles.indexOf('integrator'));         // still ordered post-integrator
    ```
  - Add a constant `const PIPELINE_POLL = 'feature-pr-poll';` and a `startPrPollRun` helper cloned from
    `startPrWatchRun` (**lines 49-63**) pointed at the new pipeline.

**Verify (focused, real harness):**
`export REVO_E2E_REAL=1 REVO_DATA_DIR=~/.revisium-orchestrator-e2e REVO_PORT=19422 REVO_PG_PORT=15640 REVO_DEV_TASKS_CONCURRENCY=8 && tsx scripts/e2e-setup.ts && tsx --test --test-concurrency=1 src/e2e/extensibility.e2e.test.ts src/e2e/routing.e2e.test.ts`
— K1-K5 pass and Group I routing still passes against the (now larger) fixture.
**Stop if:** adding the role/pipeline breaks `loadPlaybookCatalogs` validation
(`assertPipelineRoleReferences`, `catalog-loader.ts:94-109` requires every pipeline role id to exist in
`roles.json` — the new `pr-poller` role must be declared) or changes any existing routing-suite assertion that
enumerates fixture pipelines/roles (re-grep `routing.e2e.test.ts` for hardcoded pipeline/role counts and adjust
only the count assertions, never the semantic ones).

### 8. Full gates

**Verify (in order):**
- `pnpm run typecheck`
- `pnpm run lint:ci`
- `pnpm run test` (whole unit suite — `tsx --test $(find src -name '*.test.ts' | sort)`)
- `pnpm run test:e2e` (Groups A–K, real harness; the script self-provisions via `scripts/e2e-setup.ts`)
**Stop if:** any gate is red. Do not weaken an assertion to make it pass; if a *kind-less* path changed behavior,
the fallback wiring is wrong — fix the wiring, not the test.

## Acceptance test

A role whose id is **unknown to all hardcoded classifiers**, positioned post-integrator by a pipeline's
`required_roles` order, is **classified** as a status role **purely from playbook data** (`kind: 'status'`), runs,
and that `kind` is observable on the resolved binding — with **zero** change to the hardcoded id lists' behavior
for existing roles:

1. `pnpm run test` and `pnpm run test:e2e` both green (Groups A–K, incl. the original K1/K3 for the *recognized*
   `pr-watcher`, unchanged).
2. New K4: a `feature-pr-poll` run executes `pr-poller` (unknown id) and completes, with `integrate_succeeded`
   emitted **before** pr-poller's step (runtime ordering proven, not just presence).
3. New K5: `simulate_route` for `feature-pr-poll` returns a `roleBinding` for `pr-poller` with `kind === 'status'`
   (proves `kind` threads to `RouteRoleBinding`), still ordered after `integrator`.
4. New workflow unit cases: unknown id `'pr-poller'` + `kind:'status'` positioned post-integrator does **not**
   throw; the same unknown id **without** `kind` **does** throw `ROUTE_UNSUPPORTED`; a real-integrator-runner
   binding stays the integrator regardless of `kind` (D7).
5. New catalog-loader unit case: a built-in id with a conflicting `kind` (`developer` + `kind:'review'`)
   **fails install** with `PLAYBOOK_INVALID_CATALOG` (D4).
6. `git grep -n "developer-backend\|pr-watcher\|qa-backend" src/pipeline/develop-task.workflow.ts` still shows the
   original id lists intact (used as `idFallback`), proving full back-compat by construction.

## Compatibility (resolved this revision — document, don't over-build)

- **No `schema_version` bump for this slice.** The host and the fixture playbook ship together. `kind` is an
  optional field; a reader that doesn't know it ignores it (`parsePlaybookManifest`/`parseRole` only reject
  *known-but-invalid* shapes, not unknown optional keys). So bumping from `2` → `3` is unnecessary and would force
  every already-installed playbook to re-declare.
- **A kind-bearing playbook is NOT forward-compatible with an older host — and it fails at INSTALL, not route
  time.** The control-plane `roles` table schema (`control-plane/bootstrap.config.json`) is strict
  (`additionalProperties: false`). A host that predates this feature has a `roles` schema that does *not* declare
  `kind`, so installing a role row carrying `data.kind` is **rejected by `createRow`** with a validation error
  (`… has unknown property "kind"`) — an **install-time** failure, not the latent route-time `ROUTE_UNSUPPORTED`
  an earlier draft of this note assumed. (This revision adds `kind` to that table schema; the already-merged
  additive migration in `src/control-plane/schema-migration.ts` reconciles an existing control-plane's schema on
  the next `revo bootstrap`, so a host running THIS code accepts the field.)
- **Follow-up (out of scope here):** the install-time rejection above is *loud* but its message is a raw
  schema-level "unknown property" error. Before any kind-dependent playbook ships to **mixed/older hosts**, add a
  capability gate that fails install with a *clear, typed* reason — e.g. a `requires_features: ['role_kind']`
  field in the manifest checked by `parsePlaybookManifest`, or a `schema_version: 3` gated on host support.
  Tracked in Out of scope. The fixture in Step 7 is exempt because it is installed only by a host that already
  has this feature (and bootstraps before install).

## Open questions / risks for reviewers

- **Q1 (recognized built-in id + conflicting explicit `kind`) — RESOLVED: REJECT at load.** The earlier draft
  silently honored the conflicting `kind` (foot-gun). This revision **rejects** it in `parseRole` with
  `PLAYBOOK_INVALID_CATALOG` (D4, Step 2): a built-in id (`orchestrator`, the developer ids, the review ids, the
  `integrator` id) carrying a `kind` that disagrees with its historical class is a load error; a matching `kind`
  is a no-op. Repurposing a built-in id is a later, explicit capability — not a side effect of this field.
- **Q2 (unknown `kind` value) — RESOLVED: REJECT at load (install-time).** An unrecognized `kind` string in the
  catalog throws `PLAYBOOK_INVALID_CATALOG` in `parseRole` (Step 2), mirroring the `MODEL_LEVELS` check — fail
  fast at install, never a permissive route-time fallback. **Separately**, a non-empty-but-invalid `kind` on a
  persisted role row is surfaced loudly (`VALIDATION_FAILURE` in `listRoles`, Step 4), not silently normalized to
  an id fallback — a corrupted source-of-truth row must not be masked.
- **Q3 (`planner` dropped from v1) — RESOLVED.** `planner` is **not** in the v1 vocabulary. It is inert today: the
  `'plan'` phase is reached only by the index-0 positional rule in `beforeDeveloperPhase`
  (`develop-task.workflow.ts:940-944`); a `planner` role at index ≥ 1 lands in `'prepare'`, so declaring `planner`
  guarantees nothing. v1 ships `developer | review | status | integrator`; add `planner` when it has a real phase
  effect (Out of scope).
- **Q4 (multiple roles of the same `kind` in one phase).** `singleRoleIndex`
  (`develop-task.workflow.ts:917-930`) throws `ROUTE_UNSUPPORTED` on **>1 developer** or **>1 integrator**; that
  guard now keys off the kind-aware `isDeveloperRole`/`isIntegratorRole`, so two `kind:'developer'` roles throw —
  intended. But **multiple `status`/`review` roles are allowed** (they map to lists). Confirm that's the desired
  cardinality (it matches today's behavior for review roles). **Still genuinely open.**
- **Q5 (widened `validatePostIntegratorBindings`).** The new capability widens what passes the post-integrator
  gate: a `kind:'status'` role **already positioned after the integrator** (even with an unknown id) is now
  accepted. Note the positional constraint — a `kind:'status'` role positioned *before* the integrator is
  unaffected (it never enters `afterIntegratorBindings`). A typo (`'staus'`) is caught at load; a *correct*
  `kind:'status'` on a role the author shouldn't have placed post-integrator is accepted by design (the author
  opted in; the gate is the closed vocabulary + load-time validation). Acceptable? **Still open for product.**
- **Q6 (`kind` on role vs. pipeline role-ref).** D1 puts `kind` on the role, so a role carries ONE classification
  everywhere it's embedded. Combined with the positional-partition limit (Invariant 2), a role's *position* is
  still set by each pipeline's `required_roles`. Per-ref override + true order-independent placement are both
  later concerns (Out of scope). Confirm the role-level default is the right first step. **Still open.**
- **Q7 (second hardcoded cluster left in place).** `isPreDeveloperAnalysisRole` /
  `insertBeforeFirstDeveloperRole` (`task-control-plane-api.service.ts:179-188`) still hardcode ids to decide
  *insertion order* of alternative roles. This slice deliberately leaves them (they're order, not phase). Flag:
  the vision's "nothing hardcoded" goal isn't fully met until that cluster is data too — track as a follow-up
  plan. **Still open (out of scope).**
