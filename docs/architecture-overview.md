# Architecture overview

Read this before changing runtime behavior. It records the invariants that keep Revo understandable and
recoverable.

## One paragraph

Revo is a local NestJS host that runs software-development tasks through short-lived agents. DBOS owns durable
progress: workflow state, retries, waits, and resume. Revisium owns meaning: playbooks, roles, pipeline
templates, inbox rows, events, costs, and projections. MCP is the agent front door, GraphQL is the UI/script front
door, and the CLI manages the daemon lifecycle.

## Layers

```text
[ CLI lifecycle ]       start / stop / status / doctor / logs / mcp bridge
        |
[ NestJS host daemon ]  product services, MCP, GraphQL, runners
        |
[ DBOS ]                durable progress and replay
        |
[ Revisium ]            meaning, projections, inbox, events, costs
        |
[ Execution ]           short-lived Claude/Codex/script/integrator processes in target repos
```

## Invariants

1. **Progress and meaning are split.** DBOS owns live workflow progress. Revisium owns product meaning and
   runtime projections. Do not use local files or process memory as durable state.
2. **The engine boundary is thin.** DBOS-specific behavior stays in the engine adapter and host lifecycle. Roles,
   runners, and Revisium data access should not depend on DBOS internals.
3. **Pipelines are data.** The pipeline shape is a versioned graph template interpreted by `pipeline-core` and
   executed by the DBOS adapter.
4. **Agents are short-lived.** A runner starts for one step and exits. Continuing work means starting a new
   process with current state, not reviving a session.
5. **Store knowledge is sealed.** Revisium table structure stays inside data-access services. DBOS tables are not
   queried directly by product code.
6. **Human decisions are state changes.** Approvals and answers resolve inbox rows and signal the parked workflow;
   they do not command agents directly.

## Data vs. code

| Data | Code |
| --- | --- |
| Playbooks, roles, pipeline templates, route gates | NestJS host modules |
| Model profiles and routing policy | DBOS adapter and host lifecycle |
| Inbox rows, events, costs, run projections | Runner implementations |
| Domain verdict labels and graph topology | MCP and GraphQL transport adapters |

Adding a role, moving a gate, or changing a branch should usually be a data change. Adding a runner, transport, or
workflow primitive is code.

## Versioning boundary

- Versioned meaning is committed: playbooks, roles, pipelines, model profiles, routing policy, and ADR-like
  product decisions.
- Runtime rows are draft-only: task runs, tasks, inbox, events, attempts, outputs, and costs.
- DBOS progress is outside Revisium and is addressed through DBOS APIs and the host adapter.

## Run lifecycle

1. A caller creates a run through MCP or GraphQL.
2. The host resolves the selected playbook and pipeline template.
3. The DBOS workflow starts or reattaches by run id.
4. `pipeline-core` emits one decision at a time.
5. The adapter executes the decision as an agent, script, gate wait, timer, fork, or completion.
6. The adapter records events/projections and feeds the recorded result back into the core.
7. Gate decisions resolve inbox rows and resume the parked workflow.

Exact contracts live in [specs/](./specs/).

## Anti-goals

- Do not hand-roll durable queues, leases, or replay.
- Do not make roles or pipeline topology into code plugins.
- Do not version high-frequency runtime rows.
- Do not expose GraphQL beyond loopback without adding the transport-level auth seam first.
- Do not let a developer agent change architecture or ADRs without an explicit pipeline role/gate for that work.
