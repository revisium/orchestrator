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
  produces?: { name: string };
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
- A gate may `produce` a gate-resolution artifact for downstream nodes. The adapter payload includes
  `outcome`, optional `note`, `resolvedBy`, `resolvedAt`, `inboxId`, and the legacy `decision`.

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
- `approve_gate`, `reject_gate`, `resolve_gate`, `answer_question`, `resolve_inbox_item`
- `summarize_gate_risk`
- `get_run_attention` (primary observation), `get_run_status` (neutral status)
- `watch_run_changes` (advanced cursor-based delivery)
- `get_run_digest`, `get_run_events`, `get_agent_activity`, `get_agent_log` (diagnostics)

GraphQL mutations:

- `approveGate`
- `rejectGate`
- `resolveGate`
- `answerQuestion`
- `resolveInboxItem`

`resolve_gate` / `resolveGate` is the named-outcome resolver for gates whose `options` are not simply
approve/reject. It validates that `outcome` is one of the pending inbox row options and requires a non-empty note
for `approve_anyway`. `approve_gate` and `reject_gate` remain compatibility wrappers for simple two-way gates, but
they reject multi-outcome gates such as plan, merge, and stuck-review gates instead of silently mapping approve to
`approve_anyway` or reject to a recovery, recheck, cancel, or abort outcome.

Verification environment blocks open a recovery gate with outcomes `rerun_with_permissions`, `continue_in_revo`,
`adopt_patch_manually`, and `abort`. Revo-owned work remains owned by Revo unless the selected outcome is
`adopt_patch_manually` and every public resolver path persists a complete `adoptionAudit`. The audit payload requires
non-empty `runId`, `step`, `role`, `targetRepo`, `targetBranch`, `actor`, `scope`, `risk`,
`verificationResponsibility`, and either `artifactRef` or `worktreeRef`; when the inbox row has a run id, the audit
`runId` must match it. `resolve_gate` / `resolveGate` carries this payload as `adoptionAudit`; `resolve_inbox_item` /
`resolveInboxItem` carries it inside the arbitrary answer object.

GraphQL subscriptions:

- `inboxItemAdded`
- `inboxItemResolved`

`get_run_attention` is the canonical normal observation surface. `get_run_status` is for neutral
dashboard/status checks. `watch_run_changes` is the advanced cursor-based delivery API.

## Run Observation Contract

Three intent-named tools replace the former transport-named surface:

### get_run_attention

Single-shot. No cursor. Answers "what currently requires attention?"

```ts
type RunAttentionResult = {
  runId: string;
  state: 'ready' | 'running' | 'pending_gate' | 'question' | 'blocked' | 'failed' | 'completed' | 'cancelled' | 'retrying';
  requiresAttention: boolean; // true iff nextAction ∈ {start_run, ask_human, inspect_digest, inspect_log}
  nextAction: 'start_run' | 'wait' | 'ask_human' | 'inspect_digest' | 'inspect_log' | 'done';
  issueRef?: IssueRef;
  inbox?: { id: string; kind: string; title: string; status: string; stepId?: string; optionCount: number };
  blockedReason?: string;
  activeAttempt?: CanonicalActivityAttemptSignal;
  suggestedTools: string[];
};
```

Gate outcome `cancel` is an intentional human stop. Pipelines that expose it MUST route to a `cancelled` terminal;
observation surfaces report `state: 'cancelled'` with `nextAction: 'done'`, not `blocked`.

Plan gates MAY expose `rework`. In that case the gate decision is fed back through run dataflow and routes to the
analyst as an iteration over the existing plan and comments, not as a new task.

### get_run_status

Single-shot. Neutral current state for dashboards and status checks. Must not include `nextAction` or `suggestedTools`.

```ts
type RunStatusResult = {
  runId: string;
  state: RunAttentionResult['state'];
  runStatus: string;
  workflowStatus: string;
  issueRef?: IssueRef;
  latestEventAt?: string;
  latestEventType?: string;
  inbox?: { id: string; kind: string; title: string; status: string; stepId?: string; optionCount: number };
  blockedReason?: string;
  activity?: RunStatusActivitySummary;
};
```

### watch_run_changes

Bounded long-poll. Cursor lives here. Returns transitions since the cursor position.

```ts
type WatchRunChangesInput = { runId: string; cursor?: string; timeoutMs?: number };
type WatchResult = { transitions: RunTransition[]; cursor: string; timedOut: boolean };
```

Rules:

- `cursor` in `watch_run_changes` suppresses already-delivered transitions. Re-calling with the returned cursor
  must not re-deliver the same gate, blocked, failed, completed, or retrying transition.
- MCP schemas cap cursor length; over-cap cursors are ignored before base64 decode or JSON parse.
- `get_run_attention` and `get_run_status` accept only `{runId}`; they never accept a cursor.
- Activity is best-effort bounded enrichment (250ms cap). A slow, unavailable, or wedged activity projection must
  not delay delivery; clients should treat missing `activeAttempt` as "not available from this observation call",
  not as proof that no work is running.
- `activeAttempt` is suppressed on completed runs in `get_run_attention`.
- Normal observation must not require `get_run(includeEvents: true)`, full logs, raw log text, full event history,
  or unbounded payloads.
- `nextAction: 'ask_human'` means resolve the inbox item through gate/question tools. `inspect_digest` means call
  `get_run_digest`. `inspect_log` means use bounded `get_agent_log` reads with offsets or `tailBytes`.
- Runner retry does not add a new state in v1. Retry evidence is exposed through the existing event,
  attempt, digest, and log surfaces (`runner_retry_scheduled`, `runner_retry_exhausted`, per-attempt rows, and
  per-attempt agent logs). `retrying` remains reserved for a future transition shape.

## Gate Kinds

Plan gate:

- Usually appears before code-changing work.
- Presents the produced plan or reviewer verdict when `gatedArtifact` / `verdictFrom` are configured.
- Approval routes forward; rejection or requested changes route according to template data.

Merge gate:

- Appears after integration/review checks and before merge.
- Agents do not merge without this gate when the selected pipeline includes it.
- Exposes `approved`, `recheck`, `address_review_threads`, `return_to_development`, `override_merge`, and `cancel`
  outcomes. `address_review_threads` and `return_to_development` both route to `triage`; `override_merge` routes to
  `confirmMerge`; `cancel` routes to `cancelledEnd`.

Question gate:

- Used when an agent or triage step needs external judgment.
- Resolved with `answer_question` / `answerQuestion`.
- The answer is fed back into the pipeline through run dataflow and the parked workflow's recorded result.

## PR Review-Feedback Loop

The review-feedback loop is a pipeline tail pattern:

```text
integrator -> pollPr
pollPr clean -> mergeReadiness
pollPr recheck -> pollPr
mergeReadiness clean -> mergeGate
mergeReadiness recheck -> mergeReadiness
mergeReadiness ci_changes -> developer rework -> integrator
mergeReadiness review_changes -> analyst triage
pollPr ci_changes -> developer rework -> integrator
pollPr review_changes -> analyst triage
triage question -> questionGate -> triage
triage fix -> developer rework -> respondThreads -> integrator
triage wontfix -> respondThreads -> pollPr
mergeGate approved -> confirmMerge
mergeGate recheck -> mergeRecheck -> mergeRecheckRouter
mergeGate address_review_threads -> triage
mergeGate return_to_development -> triage
mergeGate override_merge -> confirmMerge   (override audit required)
mergeGate cancel -> cancelledEnd
```

Contracts:

- CI/Sonar failures route to developer rework.
- Review comments route to analyst triage first.
- Ambiguous comments route to a question gate.
- Pending provider/check readiness stays internal as a `recheck` PR feedback verdict; it does not surface as clean or
  terminally block while it can still be re-polled.
- `respondThreads` replies to and resolves only the threads it triaged as `fix` or `wontfix`.
- Resolved or reopened threads are detected by the next PR poll.
- Thread maps and triage decisions ride `run_outputs`; no separate durable PR-thread table exists in v1.
- Unresolved review threads are an independent blocker: `pollPr` / `mergeReadiness` emit `review_changes` when threads
  exist, even when CI is green. A run blocked at `mergeGate` with live unresolved threads uses
  `address_review_threads` or `return_to_development` (both route to triage) rather than `recheck` (which only
  re-polls providers).
- `override_merge` bypasses thread resolution. It requires a `mergeOverrideAudit` payload on the `resolve_gate` call:
  `threadIds`, `actor`, `reason`, `risk`, `verificationResponsibility`, and `headSha` (which is SHA-guarded against
  the live head at merge time). The audit is persisted in the gate-resolution artifact and the existing SHA guard in
  `confirmMerge` remains in force.
- Known informational bots (`sonarqubecloud`, `cursor`, `linear-app`, `deepsource-autofix`) are suppressed into
  `ignoredNoise`; all other bot comments surface in `developerFixes` with `source: 'bot_comment'`.

## Changelog

- 2026-07-01: Documented merge-gate thread-recovery outcomes (`address_review_threads`, `return_to_development`,
  `override_merge`), thread-as-independent-blocker contract, override audit requirement, and informational-bot
  suppression allowlist (issue #233).
- 2026-07-01: Added cancelled run observation and documented named `cancel` / iterative plan rework gates.
- 2026-06-29: Replaced legacy run-observation tools with get_run_attention (primary), get_run_status
  (neutral), and watch_run_changes (advanced delivery). Cursor moves to watch_run_changes only.
- 2026-06-27: Documented that runner retry evidence uses existing observation surfaces without adding a new
  retry-specific state.
- 2026-06-26: Added the initial low-context run-observation contract and documented older watch tools as
  compatibility surfaces.
- 2026-06-26: Initial spec extracted from current inbox/gate implementation, former inbox doc, and former
  plan 0018.
