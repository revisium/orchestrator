# Roadmap & doc status

Living page: per-doc draft status, dependencies, and the build-slice roadmap. Updated as each slice lands. The
[docs index](./README.md) stays lean — this page absorbs the churn.

## Doc status & dependencies

| Doc | Status | Realized by | Depends on |
| --- | --- | --- | --- |
| [architecture-overview](./architecture-overview.md) | Stable | — (orienting) | — |
| [getting-started](./getting-started.md) | Draft | Plan 0001 | Plan 0001, config |
| [control-plane-schema](./control-plane-schema.md) | Draft | Plan 0001 | architecture-overview, bootstrap.config.json |
| [repo-layer-contract](./repo-layer-contract.md) | Draft | Plan 0002/0004 (rows + transport) + 0006 (verbs) | architecture-overview, control-plane-schema, open-questions |
| [open-questions](./open-questions.md) | Living | — (tracker) | repo-layer-contract, control-plane-schema |
| [context-budget](./context-budget.md) | Draft | Plan 0007 (`buildContext`) | repo-layer-contract, control-plane-schema |
| [runner-contract](./runner-contract.md) | Draft | Plan 0008 (Claude Code headless, TBD) | repo-layer-contract, control-plane-schema, context-budget |
| [inbox-and-gates](./inbox-and-gates.md) | Draft | Plan 0009 (TBD) | repo-layer-contract, control-plane-schema |
| [multi-repo-strategies](./multi-repo-strategies.md) | Draft | Plan 0010 (TBD) | architecture-overview, repo-layer-contract, open-questions |

## Build-slice roadmap

> **Numbering note:** the create-run CLI workflow took the 0003 slot ahead of the loop, shifting every later
> slice by one from the original brief order. The table below is the current, on-disk numbering.

| Plan | Status | Scope |
| --- | --- | --- |
| [0001 — daemon + bootstrap](./plans/0001-revisium-daemon-and-bootstrap.md) | Executed | `revo` daemon CLI + control-plane bootstrap + getting-started/schema docs |
| [0002 — control-plane data access](./plans/0002-control-plane-data-access.md) | Executed | minimal generated-REST row access for draft runtime rows (first implementation; superseded in runtime code by Plan 0004) |
| [0003 — create-run workflow](./plans/0003-create-run-workflow.md) | Executed | `revo run create`: writes run/task/initial-step/event skeleton into draft runtime rows |
| [0004 — Revisium client transport](./plans/0004-revisium-client-transport.md) | Executed | migrate runtime data access from generated endpoint to `@revisium/client` System API scopes (`draft`/`head`) |
| [0005 — run observability](./plans/0005-run-observability.md) | Draft | read-only `revo run list/show/events` (+`--json`) through the client-backed data-access layer |
| [0006 — step-lifecycle verbs](./plans/0006-step-lifecycle-verbs.md) | Draft | hot-path data-access verbs: `claimNextStep`/`startAttempt`/`writeResult`/`failStep`/`createSteps`/`recoverInFlight`; opens `attempts`+`cost_ledger` |
| [0007 — dumb worker loop](./plans/0007-dumb-worker-loop.md) | Draft | the dumb loop + **stub** runner + minimal roles/model_profiles seed + `loadRole`/`loadModelProfile` (head reads) + `buildContext` + `revo work` |
| 0008 — Claude Code runner | Not written | real `runAgent` for Claude Code headless: `claude -p`, isolation, timeout, idempotency, result envelope |
| 0009 — inbox + CLI | Not written | pushInbox/resolveInbox + `inbox/show/approve/answer`; resolves `needsHuman` parks |
| 0010 — multi-repo strategies | Not written | primitives / engine / strategies |
| 0011 — GitHub integration | Not written | poll PR/CI/comments + comment sorter |

> Slices 0008+ are indicative, derived from brief §13 — order may shift. "Plan TBD" docs describe a slice whose
> work-order is not written yet: the doc is the design, the plan turns it into step-by-step build instructions.
