# Human gates v1 spec

- **Status:** Accepted.
- **Source files:** `src/pipeline-core/types.ts`, `src/pipeline/await-human.ts`, `src/revisium/inbox.service.ts`,
  `src/features/inbox/**`, `src/api/graphql-api/inbox/**`, `src/mcp/mcp-tools.ts`,
  `src/task-control-plane/run-watch.service.ts`, `src/poller/pr-readiness.ts`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md).

## Scope

Human gates are durable pauses in a run that require a user or reviewer decision. The gate is represented as a
pipeline `humanGate` node and an inbox row. Resolving the inbox row signals the parked DBOS workflow.

## Gate Node Contract

```ts
type HumanGateNode = {
  kind: 'humanGate';
  reason: string;
  outcomes: string[];
  branches: Branch[];
  timeout?: { after: string; goto: string };
  incrementCounters?: string[];
  gatedArtifact?: {
    node: string;
    as?: string;
    iteration?: 'latest' | 'all' | number;
  };
  verdictFrom?: {
    node: string;
    iteration?: 'latest' | 'all' | number;
  };
};
```

Rules:

- `outcomes` must be a subset of the template's domain verdicts.
- Branch guards route on the human verdict.
- A missing timeout means the gate can wait indefinitely.
- `gatedArtifact` and `verdictFrom` enrich the inbox row; they do not change routing semantics.

## Inbox Contract

Inbox rows are runtime draft rows and are not committed as versioned meaning. Logical fields:

```text
inbox {
  id
  kind                 // approval | question | alert
  run_id
  task_id
  step_id
  project_id
  title
  context
  options
  status               // pending | resolved
  answer
  resolved_by
  created_at
  resolved_at
}
```

Human decisions are state changes, not direct commands to agents. A resolver writes the decision to the inbox row
and signals the parked workflow. The workflow then resumes and routes through the pipeline graph.

## Current Product Verbs

MCP tools:

- `list_inbox`, `get_inbox_item`, `get_pending_decisions`
- `approve_gate`, `reject_gate`, `answer_question`, `resolve_inbox_item`
- `summarize_gate_risk`
- `wait_for_run`, `wait_for_any_gate`, `watch_runs`

GraphQL mutations:

- `approveGate`
- `rejectGate`
- `answerQuestion`
- `resolveInboxItem`

GraphQL subscriptions:

- `inboxItemAdded`
- `inboxItemResolved`

`wait_for_any_gate` and `watch_runs` are bounded long-poll tools. They return a cursor so callers can resume
polling without re-delivering already-seen transitions.

## Gate Kinds

Plan gate:

- Usually appears before code-changing work.
- Presents the produced plan or reviewer verdict when `gatedArtifact` / `verdictFrom` are configured.
- Approval routes forward; rejection or requested changes route according to template data.

Merge gate:

- Appears after integration/review checks and before merge.
- Agents do not merge without this gate when the selected pipeline includes it.

Question gate:

- Used when an agent or triage step needs external judgment.
- Resolved with `answer_question` / `answerQuestion`.
- The answer is fed back into the pipeline through run dataflow and the parked workflow's recorded result.

## PR Review-Feedback Loop

The review-feedback loop is a pipeline tail pattern:

```text
integrator -> pollPr
pollPr clean -> mergeGate
pollPr ci_changes -> developer rework -> integrator
pollPr review_changes -> analyst triage
triage question -> questionGate -> triage
triage fix -> developer rework -> respondThreads -> integrator
triage wontfix -> respondThreads -> pollPr
```

Contracts:

- CI/Sonar failures route to developer rework.
- Review comments route to analyst triage first.
- Ambiguous comments route to a question gate.
- `respondThreads` replies to and resolves only the threads it triaged as `fix` or `wontfix`.
- Resolved or reopened threads are detected by the next PR poll.
- Thread maps and triage decisions ride `run_outputs`; no separate durable PR-thread table exists in v1.

## Changelog

- 2026-06-26: Initial spec extracted from current inbox/gate implementation, former inbox doc, and former
  plan 0018.
