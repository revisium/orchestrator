# ACP + OpenCode: Pre-Integration Experiment Matrix

- **Date:** 2026-07-08
- **Status:** PoC plan outside production code. These experiments are required before the `AcpManager` ADR.

## Working Principle

Use a separate research protocol for this kind of work:

1. Test outside the project and outside Revo production modules.
2. Define hypotheses and edge cases before integration.
3. Check hypotheses with small PoC scripts.
4. Save raw logs and final conclusions.
5. Only then write the ADR/spec and move the decision into the project.

## Baseline Hypotheses

H1. `opencode acp` over `stdio` is safe to use as a short-lived subprocess for one session.

H2. One `opencode acp` can create several sessions, but that must be proven safe for Revo.

H3. Several sessions in one process can help startup/cache behavior, but weaken failure isolation.

H4. If model/effort/mode are process-scoped, one ACP process cannot be shared across steps with different model profiles.

H5. If model/effort/mode are session-scoped in OpenCode ACP, reusing one process is technically possible, but requires an `AcpManager` with routing, limits, and cleanup.

H6. `stdio` transport does not provide reliable reconnect after Revo restart without a separate supervisor/socket layer.

## Common PoC Harness

The PoC should live in `scripts/` or a separate local directory and must not use Revo runner abstractions. It should speak directly to `opencode acp` over JSON-RPC.

Requirements:

- start an `opencode acp` child process;
- send `initialize`;
- send `session/new`;
- send `session/prompt`;
- read `session/update`;
- log raw JSON-RPC to JSONL;
- support isolated cwd by default, for example `/tmp/revo-opencode-acp-research`;
- do not hardcode port/provider;
- accept model through env;
- keep code comments explaining protocol phases.

## Experiments

### E1. One ACP / One Session / One Prompt

Goal: baseline.

Check:

- `initialize` response;
- agent capabilities;
- `session/new` result;
- chunks by `sessionId`;
- final `session/prompt` result;
- `usage_update`;
- `session/close`.

Success criteria:

- prompt completes;
- events belong to the correct `sessionId`;
- process shuts down correctly.

### E2. One ACP / Two Sequential Sessions

Goal: understand whether one process can be used more than once.

Scenario:

1. start `opencode acp`;
2. `session/new` A;
3. prompt A;
4. `session/new` B;
5. prompt B;
6. close A/B.

Success criteria:

- both prompts complete;
- chunks do not mix;
- usage is readable separately;
- closing each session does not break the other.

### E3. One ACP / Two Parallel Sessions

Goal: check concurrency and routing.

Scenario:

1. start one daemon;
2. create session A and B;
3. send prompt A and prompt B concurrently;
4. collect updates by `sessionId`.

Success criteria:

- both prompts complete;
- updates can be separated reliably by `sessionId`;
- no deadlock;
- cancellation/close of one session does not affect the other.

### E4. Two ACP / One Session Each

Goal: compare with the `1 process / 1 session` model.

Check:

- two independent `opencode acp` processes;
- one prompt in each;
- parallel execution;
- resource usage;
- blast radius when killing one process.

Success criteria:

- failure of one process does not break the other;
- ownership is simple: process -> session -> step/attempt.

### E5. Different Model/Effort/Mode

Goal: understand model routing scope.

Check:

- what `initialize` returns for config options;
- whether model can be set at session level;
- whether model can be changed between sessions;
- whether effort/mode can be changed between sessions;
- how it appears in raw ACP messages.

Success criteria:

- model/effort/mode scope is clear: process-scoped or session-scoped;
- it is clear whether one ACP process can serve steps with different model profiles.

### E6. `session/load` And `session/resume`

Goal: understand persistence/reconnect semantics.

Check:

- capabilities `loadSession`, `sessionCapabilities.resume`;
- create a session, then close client/process scenarios;
- try `session/load`;
- try `session/resume`;
- see whether replay happens.

Success criteria:

- it is clear what is actually restored;
- it is clear whether this is reconnect after Revo death or only session persistence.

### E7. Cancellation

Goal: understand stop behavior.

Check:

- long prompt;
- `session/cancel`;
- final stop reason;
- whether the process remains alive;
- whether the same session/process can be reused after cancel.

Success criteria:

- the contract for Revo timeout/cancel is clear.

### E8. Permission Request

Goal: understand policy integration.

Check:

- OpenCode config/agent with permission `ask`;
- prompt that requires a tool;
- receive `session/request_permission`;
- answer allow/deny;
- inspect final updates/errors.

Success criteria:

- it is clear how `AcpManager`/runner should answer permission requests.

### E9. Context Overflow

Goal: understand error/summarization behavior.

Check:

- small context model/server;
- large prompt/project cwd;
- inspect `session/update`, final result/error;
- understand whether OpenCode tries to compact context.

Success criteria:

- it is clear whether overflow is retryable;
- it is clear what diagnostics should be stored in artifacts.

### E10. Provider/API Error

Goal: understand failure mapping.

Check:

- provider unavailable;
- bad API key or bad baseURL;
- model not found;
- final error shape.

Success criteria:

- retryable errors are understood;
- user-facing diagnostics are understood.

### E11. Client Death / Reconnect

Goal: check the most important lifecycle hypothesis.

Scenarios:

- kill the PoC client and leave child process alive if possible;
- check whether `opencode acp` is alive;
- try to connect a new client to the old process;
- separately check `session/load`/`session/resume` in a new process.

Success criteria:

- it is clear whether `opencode acp` can be treated as a reconnectable daemon;
- if not, capture the constraint for the ADR.

## Decision Matrix

Fill this after the experiments:

| Question | Answer | Evidence | Revo consequence |
|---|---|---|---|
| Can one process hold several sessions? | TBD | raw log | daemon scope |
| Do parallel sessions work? | TBD | raw log | pooling/concurrency |
| Is model session-scoped? | TBD | raw log | model profile routing |
| Is stdio reconnect possible? | TBD | raw log | restart strategy |
| Is cancel reliable? | TBD | raw log | timeout/cancel implementation |
| Is permission flow clear? | TBD | raw log | role policy |

## Preliminary Conclusion Before Experiments

Until proven otherwise, v1 should be designed conservatively:

```text
1 ACP process / 1 session / 1 step-or-attempt
```

In this variant, `AcpManager` is needed not for pooling but for lifecycle and observability:

- start process;
- create session;
- attach ownership to pipeline/run/step/attempt;
- stream updates;
- cancel/close/stop;
- persist desired/observed state;
- clean up orphaned state after Revo restart.

Expanding to `1 ACP process / N sessions` is allowed only after successful E2/E3/E5/E7/E11.
