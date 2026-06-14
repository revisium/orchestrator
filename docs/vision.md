# Product vision

> What `revo` is for, who it serves, and where it is going. The architectural invariants live in
> [architecture-overview.md](./architecture-overview.md); the build sequence lives in [roadmap.md](./roadmap.md);
> the engine decision lives in [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md).
> This doc does not restate them — it says why they are worth building.

## One paragraph

**`revo`** (`@revisium/orchestrator`) is a **local orchestrator** that runs software-development tasks via
**short-lived AI agents under deterministic control**. The pipeline — architect → developer → reviewer →
integrator — is driven by a durable engine, not by an agent's goodwill: gates, budgets, and iteration caps are
enforced by code and data, never by prompts. The developer **steers through approvals** — the plan before the
code, the diff before the merge, the price before the bill — instead of babysitting a terminal. Everything that
gives agent work meaning lives in **Revisium** as typed, reviewable data: roles, policies, and ADRs are
versioned (committed); runtime records — events, attempts, cost — are draft data, never committed. Execution
progress lives in DBOS, not Revisium.

## The pains

- Agents can't be trusted blindly — you need the plan before code, the diff before merge, the price before
  the bill.
- Agents need babysitting — approvals chain you to a terminal.
- Notifications arrive where the tool lives, not where the developer lives.
- You can't intervene mid-run — only kill it.
- "What happened overnight?" — no picture across runs, steps, spend.
- Live sessions are expensive and degrade — context grows, quality drops.
- Agent knowledge (roles, prompts, policies) lives in flat, scattered files or chat — no typed schema, no review-as-status, no product UI.
- Configuration is a rabbit hole: YAML, prompts, models — scary to start.
- Agent memory is ephemeral — every run rediscovers the project.
- Decisions (ADRs, plans) drown in chat logs and don't survive the session.
- A crashed process is lost work — no durable execution out of the box.
- Nobody knows where the tokens and money went.
- Cloud agents demand your code and infrastructure leave the building.
- Lock-in to a single agent vendor.

## What we provide

*This is the product thesis across all stages — not everything below is shipped; the capability map further down
marks what exists today vs what is planned.*

- The orchestrator is deterministic code, not an agent: gates cannot be "forgotten".
- Short-lived agents + narrow context: state, not history — cheap and restartable.
- Durable execution (DBOS): a crash is not a loss; the run resumes from the first unfinished step.
- Two mandatory gates: plan and merge. The human decides — the system waits.
- A human decision is a state change: one-action approve, wherever it's convenient.
- The inbox comes to the developer: GitHub, messenger, their own agent (MCP) — not the other way around.
- Roles, prompts, policies, models are versioned typed data: diff, review, rollback.
- Plans and ADRs are artifacts with review and comments, not chat messages.
- Human comments (PR, plan, diff) are ordinary pipeline steps: agents triage and act on them.
- The system proposes the pipeline/roles for a task — the human only approves.
- Full provenance: model, params, tokens, cost, verdict — per attempt.
- Budgets and iteration caps are data, not hope: the run stops itself.
- Domain memory: agents accumulate project knowledge in typed tables, not embeddings.
- Local-first: one package, one Postgres; your repo checkout, orchestration state, and infrastructure stay local — model traffic depends on the runner you choose.
- BYO agent: Claude Code today, Codex tomorrow — we are the control layer, not the model vendor.
- 15-minute onboarding (target flow): `revo up` → `revo init` → first PR, zero YAML.

## Principles

The five invariants — meaning/progress split, swappable engine, short-lived agents, sealed store knowledge,
human decision as state change — live in [architecture-overview.md](./architecture-overview.md). This doc does
not restate them; everything above builds on them. If a product idea requires breaking one, the idea is wrong,
not the invariant.

## The interaction model (target state)

The developer:

- **formulates tasks in their own agent** — the orchestrator is reachable as tools via MCP;
- **approves in their pocket** — a push card with the plan, the cost, and the risk; one action;
- **merges on GitHub** — the merge gate becomes the GitHub merge itself, not a parallel ceremony;
- **configures and investigates in a versioned UI** (Revisium) — roles, policies, run history, spend;
- **uses the terminal only for `revo up` and CI.**

Every surface is a thin client over the same state. This is the engine/session symmetry from
[architecture-overview.md](./architecture-overview.md): the autonomous engine and the interactive human are
indistinguishable by their effect — both just change state.

Today's alpha: tasks start via CLI (`revo run create --pipeline-id local-change --start --wait`) and gates resolve via
`revo inbox resolve`.

## Capability map by stage

**Now** — MVP, slices 0001–0008 (landed; see [roadmap.md](./roadmap.md)):

- pipeline as code: architect → developer → reviewer → integrator, durable end-to-end;
- plan and merge gates via the human inbox;
- live Claude Code runner;
- budgets and iteration caps as data;
- per-attempt provenance (model, params, tokens, cost, verdict).

**Next:**

- playbook install/import — `revo playbook install` reading `@revisium/agent-playbook` catalogs;
- review threads — one primitive, three anchors: PR comments triaged by type (code fix → developer; question →
  answer in-thread; design objection → escalate), pre-PR diff review in our own UI (Monaco), plan/ADR section
  comments at the plan gate;
- `revo up` — single process;
- MCP server — the orchestrator as tools inside the developer's agent.

**Later:**

- route proposal — the system suggests the pipeline/roles for a task; the human approves;
- policy editor UI on Revisium-admin — versioned, reviewable role/policy edits;
- runs board — the cross-run picture: status, steps, spend;
- domain memory — typed project tables that agents query;
- projects / multi-repo;
- model/execution profiles management.

## Differentiators

- Versioned **structured, typed, reviewable** knowledge as the source of truth of agent work — schemas, foreign
  keys, review-as-status — vs. flat git files (git-native standards) and vs. config-in-code
  (frameworks/products).
- Durable execution in a **local-first form factor**: an in-process library over one Postgres — no server to
  operate (vs. Temporal-class engines; see [adr/0001](./adr/0001-execution-engine-and-host.md)).
- **BYO coding agent**: complementary to model vendors, not competing with them.
- **Per-attempt provenance** — not "reproducibility": agent runs are non-deterministic; we sell auditability
  per attempt.
- A **ready UI + multi-user review surface** (inherited from Revisium) — git-native standards have no UI; local
  CLIs have no multi-user.

## Anti-goals

Extending the list in [architecture-overview.md](./architecture-overview.md), not duplicating it:

- **Not an agent framework.** We orchestrate agents; we do not provide a library for building them.
- **No ML / self-tuning.** Routing, budgets, and policies are explicit data edited by humans, not learned weights.
- **Not a CMS.** Domain tables are designed by agents inside runs and reviewed by humans — we do not ship a
  content-modeling product.
- **No live sessions.** Short-lived agents are a load-bearing invariant, not a temporary limitation.
- **We do not build our own coding agent.** Claude Code, Codex, and successors are the workforce; we are the
  control layer.

## Glossary

- **Playbook** — a named, versioned set of roles + pipelines + policies installed into the engine. The engine
  executes any playbook; `default` is the built-in playbook shipped with the engine; `revisium` is the canonical
  playbook, distributed as the npm package `@revisium/agent-playbook` (the engine imports its catalogs).
  Per-run playbook provenance recording (`playbook: <name>@<version>`) is planned, not landed.
- **Role** — a named agent definition (prompt, model level, scope, runner) — data in Revisium, not code.
- **Pipeline** — the ordered steps a run executes (architect → developer → reviewer → integrator), including
  gates and review loops.
- **Run** — one task moving through a pipeline, durable from creation to merge.
- **Gate** — a mandatory human decision point; the workflow parks until the human resolves it. MVP has two:
  plan and merge.
- **Inbox** — the single queue of pending human decisions and agent questions; resolving an item resumes the
  parked workflow.
- **Attempt** — one execution of one step by one agent process; the unit of provenance and cost accounting.
- **Provenance** — the recorded facts of an attempt: playbook, role, model, params, tokens, cost, verdict.

## North-star metric

**Time-to-first-merged-PR.** From `revo up` on a fresh machine to the first merged PR authored by a run.
Everything that increases it is a product bug.
