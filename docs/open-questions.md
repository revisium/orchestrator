# Open questions

> **Updated by the DBOS pivot ([ADR-0001](./adr/0001-execution-engine-and-host.md)).** **Q1 (atomic compare-and-
> set) and Q3 (server-side filter/sort for the claim query) are resolved — removed as concerns:** the durable
> engine (DBOS) owns step claiming, leasing, and queue dequeue, so Revisium never runs the hot claim query. Q2
> (revision/commit mechanic for versioned `roles`/`model_profiles`/`routing_policy`), Q4 (custom MCP), and Q5
> (release channels) still stand.

> Things to **verify against real Revisium, not guess** (brief §15). Each has an owner-slice, a "blocks what"
> line, and a place to record the answer. When you resolve one, fill in **Answer** with the date and evidence
> (the exact API call / doc link), then update the dependent doc. Do not implement past an unresolved **BLOCKING**
> item.

Legend: **BLOCKING** = a slice cannot be correctly built until answered. **ADVISORY** = affects design quality,
not correctness.

---

## Q1 — Atomic conditional row update (compare-and-set)

Does Revisium's API support "update row to `claimed` **only if** status is currently `ready`" in one atomic
operation (optimistic concurrency / conditional write)?

- **Severity:** ADVISORY for MVP, **BLOCKING** before multiple workers.
- **Blocks:** the multi-worker claim path in `claimNextStep`
  ([repo-layer-contract.md](./repo-layer-contract.md)).
- **Why it can wait:** the MVP runs a **single worker**, so there is no claim race; read-then-write is safe.
- **What to check:** `patch_row`/`update_row` for a conditional/`if-match`/version field; or whether row
  revisions give an ETag-style guard. If absent, document the constraint and keep claim single-worker.
- **Answer:** _(unresolved)_

## Q2 — Revision / commit mechanic for versioned tables

Exactly how is a revision created (commit) via `@revisium/client`, and how do you read the committed `head` vs.
the `draft`?

- **Severity:** BLOCKING for any edit to versioned tables; ADVISORY for the runtime hot path (which never
  commits).
- **Blocks:** `loadRole` / `loadModelProfile` reading `head`; any out-of-band edit to roles / model_profiles /
  routing_policy ([repo-layer-contract.md](./repo-layer-contract.md), versioning boundary in
  [control-plane-schema.md](./control-plane-schema.md)).
- **What to check:** the client call equivalent to `create_revision` (args, return), and how to target `head` vs
  `draft` on reads (URI `:head` / `:draft` per the MCP convention). Confirm reads default to `draft`.
- **Answer:** _(unresolved)_

## Q3 — Row read / filter / sort format and limits

What is the exact row read API in `@revisium/client` — server-side **filter + sort + pagination**, or
fetch-then-filter in process? What are the limits?

- **Severity:** BLOCKING for a correct, efficient `claimNextStep`.
- **Blocks:** the hot select in `claimNextStep` (status `ready` + `runAfter <= now` + `role ∈ roles`, ordered by
  `priority`/`createdAt`).
- **Why it matters:** if there is no server-side filter, the select must page and filter client-side — affects
  correctness under load and the index/field choices in the schema.
- **What to check:** `get_rows` filter/where/orderBy/limit support and max page size.
- **Answer:** _(unresolved)_

## Q4 — Custom MCP servers on the working Claude Code subscription

Can the Claude Code subscription in use connect **custom MCP servers** (in case we later expose the orchestrator
itself as an MCP server)?

- **Severity:** ADVISORY (future-facing, not on the MVP path).
- **Blocks:** nothing now; informs a possible "orchestrator-as-MCP" direction.
- **What to check:** subscription/policy for custom MCP endpoints in headless runs.
- **Answer:** _(unresolved)_

## Q5 — How domain projects ship releases (for the `release` strategy)

How do the real projects do releases / version publication — npm, internal registry, tags?

- **Severity:** ADVISORY until the multi-repo strategy slice (§10.1).
- **Blocks:** the `release` edge-type strategy and the `release_version` primitive
  (see multi-repo-strategies.md).
- **What to check:** per-project release channel and the command/trigger an `integrator` step would invoke.
- **Answer:** _(unresolved)_

---

## How to resolve (for the next slice)

Before building the data-access layer (Plan 0002), resolve **Q2** and **Q3** (both BLOCKING for that slice)
against a running standalone:

1. Read `@revisium/client` types/README in `/Users/anton/projects/revisium/revisium-client`.
2. Probe the live standalone REST/Swagger at the resolved port (`/api`) for filter/sort and revision endpoints.
3. Record each **Answer** here with the exact call + date, then update
   [repo-layer-contract.md](./repo-layer-contract.md) to drop the corresponding **OPEN** flag.

Q1, Q4, Q5 can stay open through the MVP — just keep the documented constraints in place until they're needed.
