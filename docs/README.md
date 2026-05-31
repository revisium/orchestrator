# agent-orchestrator docs

Documentation for the local AI-agent orchestrator built on Revisium. Repo-local context lives in
[`../AGENTS.md`](../AGENTS.md); reusable method lives in the `../agents` repo.

## Read order

1. [architecture-overview.md](./architecture-overview.md) — the invariants; read first.
2. [getting-started.md](./getting-started.md) — run the local Revisium daemon + bootstrap.
3. [control-plane-schema.md](./control-plane-schema.md) — the 10 tables; versioned vs runtime.
4. [repo-layer-contract.md](./repo-layer-contract.md) — the data-access verbs (spec for slice 0002).
5. [open-questions.md](./open-questions.md) — unresolved API questions; resolve before depending on them.

## Reference docs (durable — "what / why")

| Doc | Area |
| --- | --- |
| [architecture-overview](./architecture-overview.md) | invariants, layers, the loop |
| [control-plane-schema](./control-plane-schema.md) | the 10 tables, versioned vs runtime |
| [repo-layer-contract](./repo-layer-contract.md) | data-access verbs |
| [context-budget](./context-budget.md) | buildContext, token economics (§8) |
| [runner-contract](./runner-contract.md) | runAgent, headless runners (§9) |
| [inbox-and-gates](./inbox-and-gates.md) | human inbox, plan/merge gates (§11) |
| [multi-repo-strategies](./multi-repo-strategies.md) | primitives / engine / strategies (§10.1) |
| [open-questions](./open-questions.md) | unresolved API questions (tracker) |

## Build slices (work-orders — "how", one-shot)

Numbered, executable plans for an implementing agent → [`plans/`](./plans/) (see [plans/README.md](./plans/README.md)).

## Status & roadmap

Per-doc draft status, dependencies, and the slice/plan roadmap → [roadmap.md](./roadmap.md).
