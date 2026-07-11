# Product vision

> This page owns the product thesis, first wedge, and stage boundaries. Runtime invariants live in
> [architecture-overview.md](./architecture-overview.md); exact contracts live in [specs/](./specs/); ADRs explain why
> durable directions were chosen.

## Product thesis

Revo is a deterministic, durable, local control plane over probabilistic AI workers. LLMs may understand, propose,
and execute work, but algorithms and humans retain authority over state transitions, budgets, gates, permissions,
and irreversible actions.

Revo does not try to make model behavior reproducible. It makes the process around that behavior explicit,
recoverable, reviewable, and auditable.

## First wedge

The first product promise is intentionally narrow:

```text
task or issue
  -> approved plan
  -> implemented and independently reviewed change
  -> pull request observed through CI and review feedback
  -> human-approved merge
```

ADRs, knowledge bases, reusable fragments, custom effects, multiple runners, and richer UI can improve this loop.
They do not replace it as the onboarding promise or the north-star path.

## Why this needs a control plane

- Agents are useful but cannot be trusted to remember a gate, respect a budget, or judge their own work alone.
- Long-lived sessions become expensive and accumulate irrelevant history.
- A crashed process should not erase completed work or a pending approval.
- Plans, evidence, review feedback, cost, and outcomes need one inspectable run record.
- GitHub feedback and human questions should route back into work without trapping the developer at a terminal.
- The repository and orchestration state should remain local; model traffic depends on the selected runner.
- The product must remain runner-neutral rather than becoming another coding agent.

## Authority boundary

Algorithms own graph validation, cursor transitions, counters, limits, policy checks, and typed-result handling.
Humans own declared approval gates and irreversible decisions. An LLM is a short-lived, replaceable worker: it may
propose a route or plan, perform an agent step, and return a typed result, artifact, verdict, or `needsHuman` signal.

An LLM does not advance the workflow cursor, resolve its own gate, change iteration or budget policy, select an
undeclared permission/effect, or publish outside the selected graph. A script/effect does not choose the next node or
open a human gate either; it performs one bounded operation and returns a recorded typed result for the reducer.

Git, GitHub, filesystem, and network operations have externally dependent outcomes. Calling them deterministic hides
the real boundary. Determinism belongs to the transition over pinned inputs and a validated recorded result.

## Capability map by stage

### Current shipped behavior

- `pipeline-core` is an I/O-free reducer over a typed graph, run state, and the last recorded result.
- The DBOS adapter owns durable progress, waits, retries, checkpoint/replay, and process recovery.
- Revo Prisma owns hot product/runtime facts: projects, runs, tasks, attempts, inbox items, events, outputs, costs, and
  their indexes. Repository selections are currently stored as run/task references rather than a first-class
  `Repository` model.
- The embedded Revisium engine owns committed/versioned control-plane meaning such as installed playbook metadata,
  roles, pipelines, model profiles, run profiles, and routing policy.
- Git and worktrees own source changes and diffs; files own large artifacts. Revo records summaries and references.
- MCP and GraphQL call shared product/application services. MCP is the agent front door; GraphQL is the UI/script
  front door; the CLI owns daemon lifecycle.
- The built-in default playbook ships the executable product bootstrap graph under
  `control-plane/default-playbook/`.
- `@revisium/agent-playbook` currently exposes catalogs for discovery, role metadata, route gates, and
  execution-policy recommendations. Its pipeline catalog does not yet provide an executable graph and the package is
  not runnable by the shipped Revo importer end to end.
- Product-owned script handlers perform integration, PR readiness, response, and merge operations. They are external
  effects with recorded results; several remain more monolithic or domain-coupled than the Draft target.
- Inbox-backed plan, question, recovery, and merge gates park and resume durable runs.

### Accepted target

Accepted ADRs establish the DBOS/NestJS host boundary, the generic pipeline-as-data reducer/adapter split, the
graph-shaped GraphQL direction, and test-architecture boundaries. The pipeline decision is substantially shipped.
The GraphQL v1 target is not fully landed while compatibility roots remain in the committed SDL.

Accepted status means the decision is approved, not that every delivery slice is complete. Conversely, implemented
code does not turn a Draft ADR into an Accepted decision.

### Draft target

The next architecture contracts propose one end-to-end execution authority chain:

```text
authoring package
  -> validated catalogs, documents, and executable graph
  -> immutable PlaybookVersion
  -> fully resolved and pinned ExecutionPlan
  -> pure reducer + durable effect shell
```

The Draft contracts also separate versioned script definitions from executions, model repositories/worktrees as
resources with explicit lifecycle, generalize approval subjects and freshness, and define the proposal-to-accepted
flow for ADR/KB meaning. Recovery reads the pinned execution plan, not mutable package HEAD, a source checkout, or a
live capability registry.

The redesign is a direct cutover for internal alpha contracts: no legacy aliases, fallback reads, dual-write storage,
hidden filesystem discovery, or public stub-vs-live runtime fork. Current behavior that has not yet been replaced stays
documented as Current; it is not promoted into the target for compatibility's sake.

### Later

- reusable, validated graph fragments after the internal graph contract stabilizes;
- trusted build/install-time custom scripts after the script/effect contract stabilizes;
- a policy and playbook editor, runs board, and richer review surfaces;
- broader project knowledge, provenance-aware retrieval, and attachments;
- additional local or remote runners through explicit capabilities;
- notification adapters and multi-user workflows over the same product state.

Later custom code is not arbitrary untrusted runtime source. Fragments and plugins must not become a premature public
API that freezes an unstable internal graph.

## Interaction model

Today an operator starts the local daemon through lifecycle commands, connects an agent through MCP, and may use the
loopback GraphQL API for UI or scripts. Runs, observation, and gates are product operations, not a free-form live
agent session.

The target interaction is equally simple from every surface: formulate a task, approve the proposed route/plan,
inspect exceptions and feedback, then approve the exact merge subject. A UI is a projection/editor over the same
commands and queries; it is not a second orchestration engine.

## Meaning, runtime facts, and source work

Revo deliberately uses different stores for different lifecycles:

| Owner | Product responsibility |
| --- | --- |
| DBOS | Workflow progress, durable waits, retries, checkpoints, and recovery |
| Revo Prisma | Hot mutable facts: projects, runs, tasks, attempts, inbox, events, outputs, costs, and indexes |
| Embedded Revisium engine | Committed/versioned meaning: installed playbooks, roles, pipeline/config definitions, and later accepted ADR/KB revisions |
| Git, worktrees, files | Source repositories, changes, diffs, and large artifacts |

The stores may share one embedded PostgreSQL cluster, but their ownership and mutation rules remain distinct.

## ADR and knowledge lifecycle

Playbook/method is reusable cross-project working method. ADRs are normative project decisions. A knowledge base holds
descriptive project facts. Run artifacts and events are evidence from one execution; they do not become accepted
meaning merely because an agent produced them.

The Draft lifecycle is:

```text
run artifact
  -> proposal branch or revision
  -> validation and review
  -> human or declared policy gate
  -> accepted project revision
  -> pinned context of future runs
```

Agents read accepted revisions by default. Proposal content enters a run only when its pipeline explicitly selects
it. Facts carry provenance and verification time; search indexes or embeddings may be derived, but are not the source
of truth.

## Differentiators

- Deterministic governance around probabilistic workers, rather than prompt-owned orchestration.
- Durable execution in a local-first package form factor.
- Short-lived workers with narrow, selected context rather than an ever-growing chat transcript.
- Runner neutrality: Claude Code, Codex, and successors are workforce behind a stable control boundary.
- Per-attempt provenance and auditability, not a false claim of model reproducibility.
- Versioned structured meaning with review and explicit acceptance.

## Anti-goals

- Revo is not an agent framework or model vendor.
- Revo does not use an LLM as the workflow engine, policy engine, or gate authority.
- Revo does not keep live agent sessions as durable state.
- Revo does not copy repositories or large diffs into routing state.
- Revo does not make chat history, embeddings, or run artifacts authoritative project memory.
- Revo does not silently expose GraphQL beyond loopback or grant effects outside declared capabilities.

## Glossary

- **Playbook** — a versioned method package of roles, pipelines, policies, references, and templates. The full
  executable package installation contract is Draft.
- **PlaybookVersion** — Draft immutable installed snapshot of one validated playbook package.
- **ExecutionPlan** — Draft fully resolved, immutable set of execution-affecting inputs pinned for one run.
- **Pipeline** — a typed state-machine graph of agent steps, script/effect steps, gates, branches, waits, joins, and
  terminals.
- **Agent step** — a node that invokes one short-lived worker through a selected role and runner.
- **Script/effect step** — a node that invokes one bounded operation and records its typed result; it does not route.
- **Human gate** — a required decision or answer that parks the run until its inbox item is resolved.
- **Run** — one task moving through one pinned route and graph.
- **Attempt** — one physical execution of a step; the unit for logs, verdict, token, cost, and timing evidence.
- **Provenance** — recorded inputs and facts that explain which playbook, route, worker, operation, and result produced
  an outcome.

## North-star metric

**Time-to-first-merged-PR.** From first local setup to the first merged pull request governed by a Revo run. Product
work that does not improve or protect that path must justify its cost.
