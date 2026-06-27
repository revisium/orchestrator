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
