# agent-orchestrator

Local orchestrator for software-development tasks driven by short-lived AI agents (triage, architect, developer,
tester, reviewer, integrator), with **Revisium** as the single source of truth. The orchestrator is a thin, dumb loop:
it claims a ready step, runs an agent with the role/model that step names, and writes the result back — the
workflow emerges from data in Revisium, not from hardcoded code.

> 🚧 **Work in progress.** Early stage — design docs and the first build slice (local Revisium daemon +
> control-plane bootstrap) are in place; the runtime is not built yet.

## Start here

- Repo context for agents: [`AGENTS.md`](./AGENTS.md)
- Architecture & invariants: [`docs/architecture-overview.md`](./docs/architecture-overview.md)
- Docs index & roadmap: [`docs/README.md`](./docs/README.md) · [`docs/roadmap.md`](./docs/roadmap.md)

## License

See [LICENSE](./LICENSE).
