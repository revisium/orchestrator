# Runner contract

This page owns the physical **agent-runner** boundary. A runner starts one short-lived AI worker and returns a recorded
result to the DBOS adapter. It does not own routing, policy, gates, or durable progress.

Current product code also dispatches named script handlers from the DBOS adapter. Those handlers are external effects,
not AI runners and not deterministic outcomes. Their Draft registry/execution contract lives in
[script-runtime-v1.spec.md](./specs/script-runtime-v1.spec.md); repository and worktree lifecycle lives in
[resources-workspaces-effects-v1.spec.md](./specs/resources-workspaces-effects-v1.spec.md).

## Status Boundary

- **Current shipped behavior:** Claude Code/Codex agent runners, product-owned named script handlers, Prisma attempt
  evidence, adapter-owned retries, and the timeout policy below.
- **Accepted target:** agent/script decisions remain data emitted by the generic reducer under ADR-0002.
- **Draft target:** runner capabilities, script definitions, resource bindings, and all execution-affecting digests are
  resolved into one immutable `ExecutionPlan`; script operations are versioned and bounded.
- **Later:** additional runners and trusted build/install-time custom scripts behind those contracts.

## Boundary

- The pipeline core emits `invokeRole` or `invokeScript` without performing I/O.
- For `invokeRole`, the DBOS adapter resolves the pinned role/runner capability and starts one agent process.
- For current `invokeScript`, the adapter resolves a product-owned handler. The Draft target resolves a pinned
  `ScriptDefinition` plus declared resource/capability bindings.
- The agent or bounded operation executes in its declared repository/workspace scope and exits.
- The adapter validates and records attempts, events, costs, outputs, and the small routing signal.
- The pipeline core alone consumes that recorded signal and chooses the next node.

## Rules

- Agents are short-lived. Do not keep live sessions as durable state.
- Agents are untrusted workers. A result may request human help, but it cannot advance the cursor, resolve a gate,
  change budgets/iteration policy, grant permissions, or publish outside the graph.
- Runner-specific CLI flags and protocol details stay inside runner implementations.
- The shared process executor owns timeout policy. Runner implementations may translate protocol events into
  generic activity or operation signals, but the executor does not know Claude Code, Codex, tool names, or
  protocol payload shapes.
- External effects must be idempotent by run/step/attempt identity where replay can repeat the call.
- Runners must respect role scope, allowed tools, and permission mode.
- The verdict menu a runner advertises to the agent (result-schema description and prompt note) must be the
  active template's accepted verdict domain. The engine fails a run terminally when an agent emits a verdict
  outside that domain, so the runner must never offer a token the template would reject. The adapter threads
  the domain into each agent step; when no domain is supplied the runner falls back to the union menu.
- Code and diffs live in git, not Revisium payloads.
- Failure output should include a concise lesson or reason for later context.
- Developer roles must not change architecture or ADR decisions unless the selected pipeline explicitly routes
  that work through the right role/gate.

## Script and Effect Boundary

Git, GitHub, filesystem, process, and network results depend on external state. The deterministic part is the reducer
transition over a validated recorded result. A script/effect performs one bounded domain operation, returns a typed
result, and never chooses the next node or creates/resolves a human gate.

The Draft script runtime pins stable behavior/implementation identity, input/output schemas, effect class,
permissions/resources, timeout/retry/idempotency policy, redaction, and events. Exact fields and failure behavior stay
in the Draft spec rather than this runner guide.

Worktree creation and release are resource lifecycle, not a script mode. Long PR observation is a graph-owned
snapshot -> wait -> recheck loop, not a script that owns routing or sleeps indefinitely. The current monolithic
integration/PR handlers remain implementation truth until those Draft contracts are delivered.

## Timeout Policy

Runner processes use two separate limits:

- `idleTimeoutMs`: default `600000`. The process is killed with failure kind `runner-idle-timeout` when no
  stdout/stderr bytes, parsed events, heartbeats, or operation activity occurs for this window and there are no
  in-flight operations.
- `wallClockLimitMs`: default `3600000`. The process is killed with failure kind `runner-wall-clock-limit` when
  total elapsed time reaches this cap, even if output or in-flight operations are still active.

`ExecRequest.timeoutMs` is the wall-clock safety cap. A role's `timeoutMs` / imported `timeout_ms` also maps only
to `wallClockLimitMs`; `0` or an absent value uses the default wall-clock cap. The idle timeout is global for this
slice and is not configured per role.

Environment overrides:

- `REVO_RUNNER_IDLE_TIMEOUT_MS`
- `REVO_RUNNER_WALL_CLOCK_LIMIT_MS`

If either variable is set, it must be a positive integer number of milliseconds. Invalid set values fail loud at
runner construction or executor policy resolution time. The wall-clock env override is the effective cap and takes
precedence over `role.timeoutMs`; runner request metadata, artifact metadata, and executor enforcement must report
the same effective cap.

## Transient Retry Policy

Transient runner retry is owned by the data-driven DBOS adapter, not by `pipeline-core`, templates, runner
implementations, or the process executor. `makeRunStep` remains the single physical runner attempt owner. The
adapter wraps `runStep` with an explicit retry loop for retryable synthetic runner failures and passes a real
physical attempt argument into each `runStep` call, so DBOS memoization, attempts, reporter streams, artifacts,
events, costs, and prompts are scoped by the physical attempt.

Defaults:

- total max attempts: `2`;
- retry backoff: `2000` milliseconds.

Environment overrides:

- `REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS`
- `REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS`

`REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS` must be a positive integer. Setting it to `1` disables retry.
`REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS` must be a non-negative integer. Invalid set values fail loud. Backoff uses
a DBOS-backed workflow sleep seam, not a raw workflow timer.

The retry policy is resolved before the DBOS workflow is enqueued and is persisted in the workflow input together
with the pinned template and route. Workflow recovery and replay use that pinned policy even if process environment
values change before or between physical attempts.

Retry applies only when the runner result is the synthetic failure envelope and `retryableCandidate` is not `false`:

```json
{
  "error": "runner_failed",
  "retryableCandidate": true
}
```

`retryableCandidate: false` disables retry. Structured timeout failures with `failureKind` equal to
`runner-idle-timeout` or `runner-wall-clock-limit` are retryable. Legacy synthetic runner failures are retryable
only for transient `timeout`, `rate_limit`, or narrowly classified crash reasons. Auth, permission, schema,
malformed output, quota, overage, missing binary, unknown runner, and configuration failures are deterministic and
are not retried.

Each physical attempt has 1-based `attemptNo` within the logical node execution. The physical `attemptId` is
deterministic from the run id, logical step key, and attempt number. The logical `stepKey` remains the graph/dataflow
identity and does not change across retry attempts for one node execution.

Durable evidence:

- `step_failed` is emitted for each failed physical attempt;
- `runner_retry_scheduled` is emitted before a retry backoff;
- `step_succeeded` is emitted for the winning physical attempt;
- `runner_retry_exhausted` is emitted when retryable attempts are exhausted;
- final `pipeline_blocked` for exhausted runner retry includes `attemptsExhausted`, `attemptsMade`, `maxAttempts`,
  `attemptIds`, `lastAttemptId`, `reason`, `lesson`, and available `failureKind`, `transientKind`, and timing data.

Activity rules:

- stdout/stderr byte chunks reset idle activity;
- parsed runner events and explicit heartbeats reset idle activity;
- generic operation starts and finishes reset idle activity;
- while `inFlightOperationCount > 0`, idle timeout is suspended;
- the wall-clock cap is never suspended.

Claude Code maps stable `tool_use.id` values to operation starts and matching `tool_result.tool_use_id` values to
operation finishes. Tool-use blocks without stable IDs only mark activity. Unmatched finishes mark activity and are
safe.

Codex JSONL events currently provide stable parsed activity events in the pinned runner fixtures. They do not expose
a stable operation-pairing ID in the current local contract, so the Codex runner marks parsed activity only and does
not create long-lived in-flight operations from inferred semantics.

Timeout failure output is structured. The synthetic runner-failure envelope includes `failureKind`,
`retryableCandidate: true`, and timing evidence: `idleTimeoutMs`, `wallClockLimitMs`, `elapsedMs`, `idleMs`,
`lastActivityAt`, `inFlightOperationCount`, `stdoutBytes`, `stderrBytes`, and `eventCount` when available. The
data-driven pipeline maps the structured failure kinds to exact blocked reasons `runner-idle-timeout` and
`runner-wall-clock-limit`; legacy free-text runner failures still use the old regex fallback.

Verification failures are classified before opening a recovery gate. Sandbox, permission, read-only filesystem,
loopback/socket, missing-capability, and other environment-only verification blocks route to a durable human recovery
gate with `nextAction: ask_human` and outcomes `rerun_with_permissions`, `continue_in_revo`,
`adopt_patch_manually`, and `abort`. Code/test/lint failures without those environment indicators stay on the normal
developer rework/failure path and must not use the recovery gate. Worker verification should use sandbox-safe data
directories and no-socket or capability-gated tests when the role sandbox cannot provide loopback/socket access.

## Output

Runner output is split:

- routing signal: core outcome, domain verdict, error code;
- provenance: attempt status, tokens, cost, logs, artifact refs;
- content: optional produced output stored through run dataflow.

The exact dataflow contract lives in [specs/run-dataflow-v1.spec.md](./specs/run-dataflow-v1.spec.md).

## Changelog

- 2026-06-29: Documented that the advertised verdict menu reconciles with the active template's accepted verdict
  domain; the adapter threads the domain into each agent step so the runner never offers an out-of-domain token.
- 2026-06-27: Documented adapter-level transient runner retry, physical attempt identity, retry policy env vars,
  and durable retry evidence.
