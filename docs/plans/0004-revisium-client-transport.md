# Plan 0004 - Move control-plane transport to @revisium/client

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** replace the Plan 0002 generated-endpoint transport with `@revisium/client`
> over the Revisium System API (`/api/...`) while preserving the existing control-plane data-access
> API used by Plans 0002 and 0003. **Out of scope:** run observability, step lifecycle verbs,
> worker loop, runners, auth/key creation, schema changes, and runtime commits.

---

## 0. Context you must read first

Read these real files before writing code:

- `docs/plans/0002-control-plane-data-access.md` - current data-access API and acceptance contract.
- `docs/plans/0003-create-run-workflow.md` - current caller expectations.
- `src/control-plane/rest-transport.ts` - current generated REST transport to replace.
- `src/control-plane/data-access.ts` - public `ControlPlaneDataAccess` contract to preserve.
- `src/control-plane/json-fields.ts` - serialized JSON field boundary to preserve.
- `src/config.ts` - live runtime config and port helpers.
- `/Users/anton/projects/revisium/revisium-client/README.md`
- `/Users/anton/projects/revisium/revisium-client/src/revisium-client.ts`
- `/Users/anton/projects/revisium/revisium-client/src/revision-scope.ts`
- `/Users/anton/projects/revisium/revisium-client/src/data-operations.ts`

Source-checked facts:

1. `@revisium/client` exposes `RevisiumClient`.
2. `client.revision({ org, project, branch, revision: 'draft' | 'head' })` returns a `RevisionScope`.
3. `RevisionScope` exposes `getTables`, `getRows`, `getRow`, `createRow`, `updateRow`, `patchRow`.
4. The generated SDK uses System API paths such as `/api/revision/{revisionId}/tables/{tableId}/rows`.
5. Mutations are guarded to draft scopes by the client layer.
6. Standalone in this repo runs with auth disabled, so do not add login/API-key setup in this slice.

Why this slice exists:

- The generated endpoint (`/endpoint/rest/...`) was useful for Plan 0002 but is the wrong long-term boundary.
- The System API is stable for platform operations, supports draft/head revision scopes, and is what
  `@revisium/client` wraps.
- Later slices need versioned `head` reads for `roles` and `model_profiles`; generated endpoint transport makes
  that awkward and leaks revision strings.

---

## 1. Package dependency

**Files to change:**

- `package.json`
- `package-lock.json`

**Implementation notes:**

Add `@revisium/client`.

Preferred:

```bash
npm install @revisium/client@^0.6.0
```

If the published package is unavailable or missing the scope API that exists in the local checkout, stop and
report. Do not silently vendor code. A temporary `file:../revisium-client` dependency is acceptable only if the
user explicitly approves that tradeoff for local MVP work.

**Verify:**

```bash
npm install
npm run typecheck
```

**Stop conditions:**

- If the installed package does not export `RevisiumClient`, stop and report the installed version.
- If `RevisionScope` lacks row methods, stop and report the actual API.

---

## 2. Add a client-backed transport adapter

**Files to create/change:**

- Create `src/control-plane/client-transport.ts`
- Change `src/control-plane/data-access.ts`
- Keep `src/control-plane/rest-transport.ts` only as a temporary legacy fallback if needed.

**Implementation notes:**

Preserve the public `ControlPlaneDataAccess` interface. Callers must not care whether the backing transport is
generated endpoint or `@revisium/client`.

Create a small adapter:

```ts
export type RevisionMode = 'draft' | 'head';

export type ControlPlaneTransport = {
  assertReady(): Promise<void>;
  listRows(table: string, options?: ListRowsOptions): Promise<EndpointList>;
  getRow(table: string, rowId: string): Promise<EndpointRow>;
  createRow(table: string, rowId: string, data: object): Promise<EndpointRow>;
  updateRow(table: string, rowId: string, data: object): Promise<EndpointRow>;
  patchRow(table: string, rowId: string, patches: PatchOperation[]): Promise<EndpointRow>;
};
```

Suggested implementation shape:

1. Read the live daemon runtime via existing config helpers.
2. Build `new RevisiumClient({ baseUrl: baseUrl(runtime.httpPort) })`.
3. Create a scope with:

```ts
await client.revision({
  org,
  project,
  branch,
  revision: mode, // 'draft' by default
});
```

4. Map existing data-access calls:
   - `listRows` -> `scope.getRows(table, options)`
   - `getRow` -> `scope.getRow(table, rowId)`
   - `createRow` -> `scope.createRow(table, rowId, data)`
   - `updateRow` -> `scope.updateRow(table, rowId, data)`
   - `patchRow` -> `scope.patchRow(table, rowId, patches)`
   - `assertReady` -> `scope.getTables({ first: 100 })` and check expected table ids.

Keep serialization/deserialization in `data-access.ts` / `json-fields.ts`, not inside the client adapter.

**Verify:**

```bash
npm run typecheck
npm test
```

Expected unit tests:

- fake `RevisionScope` maps row responses into the existing `ControlPlaneRow` shape.
- `createRow`/`updateRow`/`patchRow` still serialize JSON-ish string fields.
- `getRow` maps missing rows to `null`.
- `assertReady` reports missing runtime tables as `BOOTSTRAP_NOT_APPLIED`.

**Stop conditions:**

- If client errors do not expose status codes, centralize message-based mapping in one helper and report the
  limitation. Do not scatter string matching across callers.
- If no-auth standalone rejects System API client calls, stop and report. Do not reintroduce generated endpoint
  calls as a silent fallback.

---

## 3. Preserve draft runtime writes and add head-read capability

**Files to change:**

- `src/control-plane/data-access.ts`
- `src/control-plane/index.ts`
- `src/control-plane/data-access.test.ts`

**Implementation notes:**

Default runtime data access remains draft-only:

```ts
createControlPlaneDataAccess(); // draft
```

Add an explicit revision option for later versioned reads:

```ts
createControlPlaneDataAccess({ revision: 'draft' | 'head' });
```

Rules:

- Draft access supports reads and writes.
- Head access supports reads only.
- Calling `createRow`, `updateRow`, or `patchRow` on a head access object must throw a clear
  `ControlPlaneError('VALIDATION_FAILURE', ...)` before reaching the client.
- Runtime command code should keep using the default draft access.
- Later `roles`/`model_profiles` readers will use `revision: 'head'`.

**Verify:**

```bash
npm run typecheck
npm test
```

Expected tests:

- default access requests `revision: 'draft'`.
- head access requests `revision: 'head'`.
- head mutations fail locally.

**Stop conditions:**

- If the client cannot create a head scope on an uncommitted/bootstrap-missing project, keep that as a normal
  `BOOTSTRAP_NOT_APPLIED`/`ROW_NOT_FOUND` path. Do not read versioned data from draft.

---

## 4. Remove generated-endpoint coupling from runtime code

**Files to change:**

- `src/control-plane/rest-transport.ts`
- `src/control-plane/index.ts`
- tests that import the old transport directly

**Implementation notes:**

After the client-backed adapter is green:

- Make `createControlPlaneDataAccess()` use `@revisium/client` by default.
- Remove direct `/endpoint/rest/...` construction from runtime data-access code.
- It is acceptable to keep `draftRestBaseUrl`/`headRestBaseUrl` only if a test or legacy smoke still needs it,
  but no production control-plane path should call it.

Use this grep as a guard:

```bash
rg "/endpoint/rest|draftRestBaseUrl|headRestBaseUrl" src/control-plane src/run src/cli scripts
```

Expected: no generated-endpoint usage in production data-access paths. Test fixtures may mention old paths only
when explicitly testing the migration fallback.

**Verify:**

```bash
npm run typecheck
npm test
rg "/endpoint/rest" src/control-plane src/run src/cli scripts
```

**Stop conditions:**

- If removing the generated endpoint breaks a behavior the client does not expose, stop and report the missing
  client method. Do not keep both live paths without a documented reason.

---

## 5. Live smoke against the System API

**Files to create/change:**

- Change `scripts/smoke-control-plane-data-access.ts`
- Change `scripts/smoke-create-run.ts` only if it imports transport internals.

**Implementation notes:**

The smoke must prove the same user-visible behavior as Plan 0002, but through the client/System API path:

1. `assertReady()`.
2. List tables through the client-backed data access.
3. Create/get/update/patch rows in draft.
4. Verify JSON-ish fields serialize/deserialize correctly.
5. Verify duplicate create is still mapped to `ROW_CONFLICT` even if the System API returns a different status
   than the generated endpoint.
6. Verify no runtime commit is created.

**Verify:**

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm install
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:control-plane
npm run smoke:create-run
```

**Stop conditions:**

- If duplicate create behavior differs, update the centralized error mapper and report the observed status/body.
- If `where`/`orderBy` behave differently under System API, record it for Plan 0005.

---

## 6. Docs

**Files to change:**

- `docs/plans/README.md`
- `docs/roadmap.md`
- `docs/plans/0002-control-plane-data-access.md` only if a short historical note is needed.

**Implementation notes:**

Do not rewrite executed plans. If `0002` says generated endpoint, leave it as history or add a small note:
"Superseded for runtime code by Plan 0004; generated endpoint was the first implementation."

Update roadmap wording from "generated REST row access" to "client/System API row access after Plan 0004".

**Verify:**

```bash
git diff --check
```

---

## 7. Final acceptance test

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
npm run smoke:control-plane
npm run smoke:create-run
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** the existing Plan 0002/0003 behavior works through `@revisium/client` and System API
scopes, generated endpoint coupling is gone from runtime code, draft writes remain draft-only, head mutation is
blocked locally, tests and smokes pass, and the daemon is stopped.

---

## 8. Report back / open findings

When done, report:

1. Installed `@revisium/client` version and whether it came from npm or local `file:`.
2. Exact System API methods used (`RevisionScope` methods).
3. Whether standalone no-auth System API calls worked without login.
4. Duplicate row create status/body under System API.
5. Whether `where`/`orderBy` work through `scope.getRows`.
6. Confirmation that no runtime commit path was touched.

Open findings for later slices:

- auth/API-key setup for cloud/self-hosted control planes.
- generated endpoint removal from bootstrap config if it becomes unnecessary.
- typed table-specific wrappers over the generic `RevisionScope` row data.
