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
- External effects must be idempotent by run/step/attempt identity where replay can repeat the call.
- Runners must respect role scope, allowed tools, and permission mode.
- Code and diffs live in git, not Revisium payloads.
- Failure output should include a concise lesson or reason for later context.
- Developer roles must not change architecture or ADR decisions unless the selected pipeline explicitly routes
  that work through the right role/gate.

## Output

Runner output is split:

- routing signal: core outcome, domain verdict, error code;
- provenance: attempt status, tokens, cost, logs, artifact refs;
- content: optional produced output stored through run dataflow.

The exact dataflow contract lives in [specs/run-dataflow-v1.spec.md](./specs/run-dataflow-v1.spec.md).
