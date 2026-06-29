# Runner contract

Runners execute one agent or script step and return a recorded result to the DBOS adapter. They do not own routing
or durable progress.

## Boundary

- The pipeline core emits `invokeRole` or `invokeScript`.
- The DBOS adapter resolves the capability handle to a runner/script.
- The runner executes in the target repo/worktree and exits.
- The adapter records attempts, events, costs, outputs, and routing signals.

## Rules

- Agents are short-lived. Do not keep live sessions as durable state.
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
