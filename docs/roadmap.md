# Roadmap & doc status

Living page: per-doc draft status, dependencies, and the build-slice roadmap. Updated as each slice lands. The
[docs index](./README.md) stays lean — this page absorbs the churn.

## Doc status & dependencies

| Doc | Status | Realized by | Depends on |
| --- | --- | --- | --- |
| [architecture-overview](./architecture-overview.md) | Stable | — (orienting) | — |
| [getting-started](./getting-started.md) | Draft | Plan 0001 | Plan 0001, config |
| [control-plane-schema](./control-plane-schema.md) | Draft | Plan 0001 | architecture-overview, bootstrap.config.json |
| [repo-layer-contract](./repo-layer-contract.md) | Draft | Plan 0002 | architecture-overview, control-plane-schema, open-questions |
| [open-questions](./open-questions.md) | Living | — (tracker) | repo-layer-contract, control-plane-schema |
| [context-budget](./context-budget.md) | Draft | brief §8 (Plan TBD) | repo-layer-contract, control-plane-schema |
| [runner-contract](./runner-contract.md) | Draft | brief §4/§9 (Plan TBD) | repo-layer-contract, control-plane-schema, context-budget |
| [inbox-and-gates](./inbox-and-gates.md) | Draft | brief §11 (Plan TBD) | repo-layer-contract, control-plane-schema |
| [multi-repo-strategies](./multi-repo-strategies.md) | Draft | brief §10.1 (Plan TBD) | architecture-overview, repo-layer-contract, open-questions |

## Build-slice roadmap

| Plan | Status | Scope |
| --- | --- | --- |
| [0001 — daemon + bootstrap](./plans/0001-revisium-daemon-and-bootstrap.md) | Ready to execute | `revo` daemon CLI + control-plane bootstrap + getting-started/schema docs |
| 0002 — data-access layer | Not written | implement [repo-layer-contract](./repo-layer-contract.md) on `@revisium/client`; resolve open Q2/Q3 first |
| 0003 — worker loop | Not written | the dumb loop (§7): claim → startAttempt → runAgent → writeResult/createSteps; recoverInFlight on startup |
| 0004 — runner | Not written | `runAgent` for Claude Code headless (§9) |
| 0005 — roles as data + first real task | Not written | seed roles/model_profiles; run one task end-to-end (§10) |
| 0006 — inbox + CLI | Not written | pushInbox/resolveInbox + `inbox/show/approve/answer` (§11) |
| 0007 — multi-repo strategies | Not written | primitives / engine / strategies (§10.1) |
| 0008 — GitHub integration | Not written | poll PR/CI/comments + comment sorter (§11.1) |

> Slices 0003+ are indicative, derived from brief §13 — order may shift. "Plan TBD" docs describe a slice whose
> work-order is not written yet: the doc is the design, the plan turns it into step-by-step build instructions.
