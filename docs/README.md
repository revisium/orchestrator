# agent-orchestrator docs

Documentation for the local AI-agent orchestrator built on Revisium. Repo-local context lives in
[`../AGENTS.md`](../AGENTS.md); reusable method lives in the `../agents` repo.

## Read order

1. [architecture-overview.md](./architecture-overview.md) — the invariants; read first.
2. [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md) — why DBOS + NestJS (the pivot).
3. [roadmap.md](./roadmap.md) — doc status + the MVP build slices.
4. [control-plane-schema.md](./control-plane-schema.md) — the tables; versioned vs runtime (post-pivot).
5. [getting-started.md](./getting-started.md) — run the local Revisium daemon + bootstrap (pre-pivot; see banner).

## Reference docs (durable — "what / why")

| Doc | Area |
| --- | --- |
| [architecture-overview](./architecture-overview.md) | invariants, layers (host + DBOS + Revisium) |
| [adr/0001-execution-engine-and-host](./adr/0001-execution-engine-and-host.md) | DBOS + NestJS decision record |
| [control-plane-schema](./control-plane-schema.md) | Revisium meaning tables, versioned vs runtime |
| [repo-layer-contract](./repo-layer-contract.md) | data-access verbs (meaning; progress verbs retired) |
| [context-budget](./context-budget.md) | buildContext, token economics (§8) |
| [runner-contract](./runner-contract.md) | runAgent, headless runners (§9) |
| [inbox-and-gates](./inbox-and-gates.md) | human inbox, plan/merge gates (§11) |
| [multi-repo-strategies](./multi-repo-strategies.md) | primitives / engine / strategies (§10.1) |
| [open-questions](./open-questions.md) | unresolved API questions (tracker) |

## Build slices (work-orders — "how", one-shot)

Numbered, executable plans for an implementing agent → [`plans/`](./plans/) (see [plans/README.md](./plans/README.md)).

## Status & roadmap

Per-doc draft status, dependencies, and the slice/plan roadmap → [roadmap.md](./roadmap.md).
