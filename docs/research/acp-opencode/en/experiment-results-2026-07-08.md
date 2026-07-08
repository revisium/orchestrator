# ACP + OpenCode: Experiment Results 2026-07-08

- **Status:** Local PoC outside Revo production code.

Harness: `orchestrator/.worktrees/opencode-acp-runner/scripts/research-opencode-acp-sessions.ts`

Artifacts: `/tmp/revo-opencode-acp-research-artifacts/*.jsonl`

Model: `llamacpp-fast/qwen-coder-7b`

Provider: local OpenAI-compatible `llama-server` through OpenCode provider config.

Context server: `n_ctx=16384`, CPU-safe mode.

## Important Harness Fix

A bug in experiment selection through `pnpm run ... -- <experiment>` was found during the first run.

Cause: `pnpm` passes the `--` separator into `process.argv`, and the parser treated `--` as the first argument and fell back to default `one-session`.

Fix:

- `parseExperimentArg` now skips a leading `--`;
- added regression test `research options allow experiment after pnpm run argument separator`;
- after the fix, `options.test.ts` passes `8/8`.

## E1. One ACP / One Session / One Prompt

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-46-19-930Z-one-session.jsonl
```

Result:

- `initialize` passed;
- `session/new` returned `sessionId`;
- `session/prompt` completed;
- `session/update` messages arrived;
- one `usage_update` arrived;
- `session/close` completed.

Conclusion:

`opencode acp` works consistently as a short-lived process for one session.

## E2. One ACP / Two Sequential Sessions

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=240000 \
pnpm run research:opencode-acp-sessions -- two-sessions-sequential
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-48-12-501Z-two-sessions-sequential.jsonl
```

Result:

- one `opencode acp` process created two sessions;
- both sessions received different `sessionId` values;
- the first session prompt completed;
- the second session prompt completed;
- each session had its own `usage_update`;
- both sessions closed through `session/close`.

Session summary:

```text
first:  updates=22, usageUpdates=1
second: updates=22, usageUpdates=1
```

Conclusion:

OpenCode ACP supports multiple sequential sessions inside one process in practice.

## E3. One ACP / Two Parallel Sessions

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=300000 \
pnpm run research:opencode-acp-sessions -- two-sessions-parallel
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-48-53-592Z-two-sessions-parallel.jsonl
```

Result:

- one `opencode acp` process created two sessions;
- two `session/prompt` calls were sent in parallel;
- both prompts completed with `stopReason=end_turn`;
- updates were separated by `sessionId`;
- each session had its own `usage_update`;
- both sessions closed through `session/close`.

Session summary:

```text
parallel-a: updates=13, usageUpdates=1
parallel-b: updates=17, usageUpdates=1
```

JSONL check:

```text
17 updates -> session parallel-b
13 updates -> session parallel-a
```

Conclusion:

OpenCode ACP supports parallel prompts in different sessions of one process in practice. For Revo, this makes `1 ACP process / N sessions` possible, but only with `AcpManager` routing, limits, cancellation, and failure policy.

## E4. Session Config Options / Model / Mode

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=300000 \
pnpm run research:opencode-acp-sessions -- different-models
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T05-52-52-138Z-different-models.jsonl
```

Result:

`session/new` returned `configOptions`:

- `model`;
- `mode`.

`model.currentValue`:

```text
llamacpp-fast/qwen-coder-7b
```

Initial `mode.currentValue`:

```text
revo-acp-research-smoke
```

The harness called:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "...",
    "configId": "model",
    "value": "llamacpp-fast/qwen-coder-7b"
  }
}
```

and:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "...",
    "configId": "mode",
    "value": "revo-acp-research-alt"
  }
}
```

OpenCode replied with the full `configOptions` list. After setting mode:

```text
mode.currentValue = revo-acp-research-alt
```

Both sessions then ran prompts and completed.

Conclusion:

OpenCode ACP supports session-level config options and accepts `session/set_config_option` for `model` and `mode`.

Experiment limitation:

In this run, `REVO_ACP_RESEARCH_ALT_MODEL` was equal to the primary model, so config option acceptance was verified, but not actual switching to another provider/model. The next experiment should use an external provider or a second locally available provider.

## OpenRouter External-Provider Confirmations

- **Status:** Additional bounded research runs through OpenCode ACP and an external provider connected through the OpenCode TUI.

### Fact: The Local OpenCode Zen Auth Problem Is Not An ACP Problem

An early smoke through provider `opencode/*` failed at provider request time before a meaningful ACP check.

Local credential state:

```text
~/.local/share/opencode/auth.json
provider=opencode
keyLength=6
keyAscii=false
```

Observed error:

```text
Header ... invalid value: 'Bearer [REDACTED]'
```

Conclusion:

This is a locally broken OpenCode Zen credential. This failure does not prove any problem with ACP transport, `session/new`, `session/prompt`, or `session/set_config_option`.

### Fact: OpenRouter Is Connected Through The OpenCode TUI

Working external model id for smoke/research:

```text
openrouter/cohere/north-mini-code:free
```

This provider/model was used as the external control run through OpenCode ACP.

### E5. OpenRouter / One-Session

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T11-48-53-118Z-one-session.jsonl
```

Result:

- `session/new` created a session;
- `session/prompt` completed;
- `updates=101`;
- `usageUpdates=1`.

Conclusion:

The external provider through OpenCode ACP is confirmed on model `openrouter/cohere/north-mini-code:free`.

### E6. OpenRouter / Different-Models / Responsive Base, Unreliable Alt

Models:

```text
base = openrouter/cohere/north-mini-code:free
alt  = openrouter/qwen/qwen3-coder:free
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T11-49-26-963Z-different-models.jsonl
```

Default session:

```text
updates=149
usageUpdates=1
```

Alternate session:

- OpenCode returned `configOptions`;
- `session/set_config_option(model=openrouter/qwen/qwen3-coder:free)` completed successfully;
- `model.currentValue` updated;
- `session/set_config_option(mode=revo-acp-research-alt)` completed successfully;
- `session/prompt` timed out after `180000ms`;
- there was no `stderr`, permission requests, or text chunks.

Conclusion:

The config surface for `model` and `mode` works: OpenCode accepted the values and updated `currentValue`. The timeout of model `openrouter/qwen/qwen3-coder:free` should be treated as provider/model-specific unreliability for smoke or a separate model timeout, not as proof that model switching is broken.

### E7. OpenRouter / Different-Models / Same Responsive Model

Models:

```text
base = openrouter/cohere/north-mini-code:free
alt  = openrouter/cohere/north-mini-code:free
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T12-05-28-967Z-different-models.jsonl
```

Default session:

```text
updates=140
usageUpdates=1
```

Alternate session after `session/set_config_option(model)` and `session/set_config_option(mode)`:

```text
updates=132
usageUpdates=1
```

Conclusion:

`session/set_config_option(model)` and `session/set_config_option(mode)` work for a responsive OpenRouter model. This run closes the E4 limitation for ACP config-option acceptance on an external provider.

### E8. OpenRouter / Two-Sessions-Parallel

Model:

```text
openrouter/cohere/north-mini-code:free
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T12-06-40-090Z-two-sessions-parallel.jsonl
```

Session summary:

```text
parallel-a: updates=204, usageUpdates=1
parallel-b: updates=299, usageUpdates=1
```

Conclusion:

One OpenCode ACP daemon can execute multiple concurrent sessions even against the external OpenRouter model.

## Architecture Consequences After OpenRouter Runs

Facts:

- `1 ACP daemon / N sessions` technically works in local and OpenRouter research runs;
- OpenCode ACP exposes `configOptions` for session-level `model` and `mode`;
- Revo can pass model/mode/effort per session through `session/set_config_option` when OpenCode exposes the corresponding `configId`;
- provider/model failures must be separated from config option acceptance.

Recommendation for Revo v1:

Use the default shape:

```text
1 ACP daemon / 1 step attempt / 1 ACP session
```

Reasons:

- isolation;
- simple cleanup model;
- simple retries;
- DBOS reconciliation without shared-daemon ambiguity;
- smaller blast radius when a process dies or a provider/model hangs.

Pooling or multi-session daemon should be treated as a v2 optimization. It must live behind policy limits and health/reconciliation in `AcpManager`.

Responsibility boundary:

- `AcpManager` owns daemon lifecycle, stdio pipes, session routing, cancellation, and cleanup;
- DBOS persists desired/observed state and reconciliation data;
- DBOS does not replace the process manager and does not own stdio pipes directly.

## Initialize Capabilities OpenCode

Actual `initialize.result`:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": {
      "http": true,
      "sse": true
    },
    "promptCapabilities": {
      "embeddedContext": true,
      "image": true
    },
    "sessionCapabilities": {
      "close": {},
      "fork": {},
      "list": {},
      "resume": {}
    }
  },
  "agentInfo": {
    "name": "OpenCode",
    "version": "1.17.14"
  }
}
```

Conclusion:

OpenCode ACP declares:

- `loadSession`;
- `sessionCapabilities.close`;
- `sessionCapabilities.fork`;
- `sessionCapabilities.list`;
- `sessionCapabilities.resume`;
- MCP `http` and `sse`;
- prompt embedded context and image.

These need separate research, especially `list`, `load`, `resume`, and `fork`.

## Updated Interim Conclusion

Before the experiments, the most conservative hypothesis was:

```text
1 ACP process / 1 session / 1 step-or-attempt
```

After the experiments, it can be refined:

```text
OpenCode ACP technically supports:
- several sessions in one process;
- parallel prompts in different sessions;
- session-level config options model/mode.
```

For Revo v1, that does not automatically mean pooling should be implemented immediately. Reasons:

- if one process dies, all sessions inside it fail;
- routing `sessionId -> pipeline/run/step/attempt` is required;
- per-session timeout/cancel is required;
- a limit on parallel sessions per process is required;
- cleanup of stuck sessions is required;
- `stdio` still does not provide process-level reconnect pipe after Revo restart;
- `load/resume` require separate research.

## What Remains To Check

The following experiments are required before the ADR:

1. Actual switching to another model/provider through `session/set_config_option`.
2. `session/list`.
3. `session/load`.
4. `session/resume`.
5. `session/fork`, if needed for pipeline semantics.
6. `session/cancel` long-running prompt.
7. Permission request flow.
8. Provider/API error.
9. Context overflow.
10. Client death / reconnect.
11. Kill ACP process with one active session.
12. Kill ACP process with multiple active sessions.

## Preliminary ADR Recommendation

For v1, consider two modes:

### Safe Default

```text
1 ACP process / 1 session / 1 step-or-attempt
```

Use this as the baseline reliable model.

### Optional Optimized Mode After More Research

```text
1 ACP process / N sessions
```

Allow it only if `AcpManager` implements:

- session registry;
- routing updates by `sessionId`;
- per-session timeout/cancel;
- process-level failure fan-out;
- max sessions per process;
- graceful `session/close`;
- DBOS desired/observed state;
- restart reconciliation policy.

## Continuation: Safe Harness Extensions And Sandbox-Blocked Runs

Date/time: 2026-07-08 09:20-09:30 Europe/Moscow.

Harness changes:

- added experiment selectors `permission-request`, `model-error`, `crash-one-session`, `crash-two-sessions`;
- added `REVO_ACP_RESEARCH_PERMISSION_MODE=ask|deny`;
- `permission-request` automatically uses `ask`, and the client answers deny to `session/request_permission`;
- summary/timeout diagnostics now include pending RPC methods, child exit/signal, stderr tail, and counters for permission requests/denials;
- crash experiments kill only the child `opencode acp` process with `SIGKILL` after starting a bounded long prompt.

TDD proof:

```bash
node --import tsx -e "import('./scripts/research-opencode-acp/options.test.ts').catch((error)=>{ console.error(error); process.exit(1); })"
```

At first, the new tests failed on missing `permissionMode`, `permission-request`, and ask-permission config.
After implementation: `13/13` pass.

Provider health was checked separately:

```bash
curl -sS http://127.0.0.1:8082/v1/models
```

Result: provider is available and returns `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`.

### Permission Request Attempt: Inconclusive, Blocked Before ACP Initialize

Command without health URL because Node `fetch` inside the sandbox got `TypeError: fetch failed`, even though the `curl` health check passed:

```bash
env REVO_ACP_RESEARCH_CWD=/tmp/revo-opencode-acp-research \
  REVO_ACP_RESEARCH_ARTIFACT_DIR=/tmp/revo-opencode-acp-research-artifacts \
  REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
  REVO_ACP_RESEARCH_TIMEOUT_MS=120000 \
  node --import tsx scripts/research-opencode-acp-sessions.ts permission-request
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T06-26-42-414Z-permission-request.jsonl
```

Result:

- `initialize` was sent;
- `opencode acp` exited with `code=1` before replying;
- stderr: `Unknown: FileSystem.open (/home/egor/.local/share/opencode/log/opencode.log)`.

After redirecting OpenCode data/state/cache to `/tmp`:

```bash
env XDG_DATA_HOME=/tmp/revo-opencode-acp-xdg-data \
  XDG_STATE_HOME=/tmp/revo-opencode-acp-xdg-state \
  XDG_CACHE_HOME=/tmp/revo-opencode-acp-xdg-cache \
  REVO_ACP_RESEARCH_CWD=/tmp/revo-opencode-acp-research \
  REVO_ACP_RESEARCH_ARTIFACT_DIR=/tmp/revo-opencode-acp-research-artifacts \
  REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
  REVO_ACP_RESEARCH_TIMEOUT_MS=120000 \
  node --import tsx scripts/research-opencode-acp-sessions.ts permission-request
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T06-27-20-842Z-permission-request.jsonl
```

The intermediate variant that also redirected `XDG_CONFIG_HOME` produced the same pre-initialize `ServeError`:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T06-26-55-001Z-permission-request.jsonl
```

Result:

- `initialize` was sent;
- `opencode acp` exited with `code=1` before replying;
- stderr: `ServeError`;
- permission requests observed: `0`.

Conclusion: permission flow is not verified yet. The harness is ready to log and deny `session/request_permission`, but the current sandbox does not let `opencode acp` reach ACP initialize. This does not prove OpenCode permissions behavior.

### Provider/Model Error And Crash Experiments

They were not run after the permission attempt because all require successful `opencode acp` startup, and the bounded permission run showed a pre-initialize `ServeError` in the current sandbox. Escalation for an unsandboxed bounded run was rejected.

Status:

- `model-error`: TODO in an environment where `opencode acp` can start;
- `crash-one-session`: TODO in an environment where `opencode acp` can start;
- `crash-two-sessions`: TODO in an environment where `opencode acp` can start;
- context overflow: TODO, run only without restarting the local model server and with a bounded timeout.

What this continuation proves:

- the harness no longer loses timeout/process context: failure summary contains pending RPC, child exit/signal, and stderr tail;
- sandbox failure is now distinguishable from provider/model/ACP failure;
- live permission/model/crash conclusions remain inconclusive.

## Continuation: Host-Local Bounded Runs After Sandbox Unblock

Date/time: 2026-07-08 12:20-12:35 Europe/Moscow.

Scope:

- only local commands were run in the research worktree;
- Revo MCP/preflight was not run;
- production `src/**` did not change;
- OpenCode provider/auth values were not printed; only provider/model ids and credential presence were recorded.

Harness additions:

- added experiment selectors `context-overflow` and `client-death-reconnect`;
- `context-overflow` generates a bounded oversized prompt inside the harness;
- `client-death-reconnect` closes stdio pipes client-side without `SIGKILL`, then checks `session/load`/`session/resume` in a new `opencode acp` process;
- `scripts/research-opencode-acp/README.md` and options tests were updated for the new selectors.

### Provider/Model Inventory

Commands:

```bash
opencode models
opencode auth list
curl -sS --max-time 3 http://127.0.0.1:8082/v1/models
```

Result:

- `opencode models` showed only configured local providers:
  - `llamacpp/qwen3-coder`;
  - `llamacpp-fast/qwen-coder-7b`;
  - `llamacpp-north/north-mini`;
  - `ollama/qwen2.5-chat-offload`;
  - `ollama/qwen2.5-coder-offload`;
  - `ollama/qwen3-offload`.
- `opencode auth list` showed credentials for `OpenCode Zen` and `ollama`, without secret values.
- `opencode models opencode` returned `Provider not found: opencode`.
- host-local `127.0.0.1:8082/v1/models` is available and returns `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`.
- `127.0.0.1:11434` and `127.0.0.1:8080` did not respond.

Conclusion:

At this point, there was no selectable external provider/model in the safe existing config. Actual external provider/model behavior had not been verified yet; later OpenRouter TUI runs above closed this gap for `openrouter/cohere/north-mini-code:free`. Safe command after explicit external provider setup:

```bash
REVO_ACP_RESEARCH_MODEL=<external-provider>/<model> \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

### Permission Request Flow

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- permission-request
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-24-32-139Z-permission-request.jsonl
```

Result:

- `initialize` and `session/new` passed;
- `permissionMode=ask` was applied in the generated OpenCode config;
- prompt asked to use a shell command only in isolated cwd;
- OpenCode did not send `session/request_permission`;
- `permission requests observed=0`;
- `permission denial responses sent=0`;
- the model generated a textual JSON-like bash request and completed `session/prompt` with `stopReason=end_turn`;
- tool execution did not happen.

Conclusion:

The real permission request callback/deny path is not proven yet. Only negative behavior is proven: with local `llamacpp-fast/qwen-coder-7b` and this prompt/model output, OpenCode did not enter the executable tool call path, so the deny callback was not invoked. A provider/model that actually emits tool calls through OpenCode, or a more precise OpenCode tool-call fixture, is required.

### Provider/Model Error After Initialize

Command with invalid configured model id:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/definitely-missing-model \
REVO_ACP_RESEARCH_TIMEOUT_MS=60000 \
pnpm run research:opencode-acp-sessions -- model-error
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-25-35-124Z-model-error.jsonl
```

Result:

- `initialize` passed;
- `session/new` passed;
- `session/new.configOptions.model.currentValue` became `ollama/qwen3-offload`, meaning OpenCode selected a fallback from existing config;
- `session/prompt` did not return a JSON-RPC error before timeout;
- after harness timeout, `session/close` returned `{}`, and then `session/prompt` returned `stopReason=end_turn`.

Command with synthetic dead localhost provider:

```bash
OPENCODE_CONFIG_CONTENT='{"provider":{"broken-local":{"name":"Broken local OpenAI-compatible","npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://127.0.0.1:65534/v1"},"models":{"missing":{"name":"Missing synthetic model"}}}}}' \
REVO_ACP_RESEARCH_MODEL=broken-local/missing \
REVO_ACP_RESEARCH_TIMEOUT_MS=45000 \
pnpm run research:opencode-acp-sessions -- model-error
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-27-11-507Z-model-error.jsonl
```

Result:

- `initialize` passed;
- `session/new` passed and showed `currentValue=broken-local/missing`;
- `session/prompt` did not return an ACP-visible JSON-RPC error in 45s;
- stderr was empty;
- after harness timeout, `session/close` returned `{}`, and then `session/prompt` returned `stopReason=end_turn`.

Conclusion:

Provider/model error shape is not proven as a structured ACP error for an unreachable provider: in these two bounded runs, OpenCode hung on `session/prompt` until client-side timeout. For Revo, this means runner timeout remains mandatory even if provider/model config already passed `initialize` and `session/new`.

### Context Overflow

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=90000 \
pnpm run research:opencode-acp-sessions -- context-overflow
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-28-17-217Z-context-overflow.jsonl
```

Result:

- generated prompt size: `493017` chars;
- `initialize` and `session/new` passed;
- OpenCode sent `usage_update` with `used=0`, `size=32768`;
- `session/prompt` returned JSON-RPC error:

```json
{
  "code": -32603,
  "message": "Internal error: Session too large to compact - context exceeds model limit even after stripping media",
  "data": {
    "service": "session",
    "errorName": "ContextOverflowError"
  }
}
```

Conclusion:

Context overflow is proven as an ACP-visible JSON-RPC error on `session/prompt`. Error appears retryable only after reducing context/prompt; blind retry against the same prompt/model is not useful. Revo should persist `errorName=ContextOverflowError`, message, model, and usage window.

### Client Death / Reconnect

Command:

```bash
REVO_ACP_RESEARCH_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_HEALTH_URL=http://127.0.0.1:8082/v1/models \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- client-death-reconnect
```

Artifact:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T09-28-36-407Z-client-death-reconnect.jsonl
```

Result:

- first `opencode acp` process started a prompt;
- harness closed client stdio pipes without killing the child first;
- old stdio process exited after pipe close: `true`;
- no same-process reconnect API exists for stdio;
- new `opencode acp` process initialized successfully;
- new process `session/load` on original `sessionId` returned `object(configOptions)` and replayed prior prompt text;
- new process `session/resume` on original `sessionId` returned `object(configOptions)`;
- prompt after new-process resume completed with `usage_update=1` and `stopReason=end_turn`.

Conclusion:

Transport-level reconnect to the same stdio process is not available and was not observed. Session persistence across a new OpenCode ACP process works through `session/load`/`session/resume` for a persisted session id. This supports a Revo design that treats lost stdio child process as dead transport and reconciles through persisted session ids only when that semantic is acceptable.

## Remaining After Local-Model Continuation

This section captured the state before the later OpenRouter TUI confirmations in this same document.

At that point, still not proven:

- real `session/request_permission` callback and deny path, because the local model did not emit executable tool calls;
- structured provider/API error shape for unreachable provider, because bounded runs hung until client timeout instead of returning ACP error;
- `session/fork`.

At that point, newly proven:

- configured local provider/model inventory and host-local model health;
- context overflow ACP error shape;
- client stdio pipe close causes old ACP stdio process to exit in this setup;
- new OpenCode ACP process can `session/load`/`session/resume` the persisted session id after client death;
- provider failures may require Revo-side timeout even after successful `initialize` and `session/new`.

## Continuation: External Free Provider Setup Attempt

Date/time: 2026-07-08 13:05-13:15 Europe/Moscow.

- **Status:** Historical setup attempt before OpenRouter was connected through the OpenCode TUI. The later OpenRouter ACP confirmations above supersede the "blocked" state for external-provider smoke, but the OpenCode Zen credential finding remains relevant.

Scope:

- production `src/**` did not change;
- live OpenCode config/auth files were not edited;
- secrets were not printed or written to the repo;
- escalation was used for OpenCode CLI introspection because the sandbox blocked access to `~/.local/share/opencode/log/opencode.log`.

Official docs facts checked:

- OpenCode config sources merge, and `OPENCODE_CONFIG_CONTENT` is an inline runtime override with high precedence.
- Custom OpenAI-compatible providers use `provider.<id>.npm="@ai-sdk/openai-compatible"`, `options.baseURL`, optional `options.apiKey`, and `models`.
- Config supports `{env:VARIABLE}` substitution for API keys.
- OpenCode Zen is the official `opencode/<model-id>` provider; its docs list free models including `opencode/north-mini-code-free`.

### Current Provider/Auth Inventory

Commands:

```bash
opencode models
opencode providers list
opencode models opencode
```

Result:

- `opencode models` still shows only configured local providers:
  - `llamacpp/qwen3-coder`;
  - `llamacpp-fast/qwen-coder-7b`;
  - `llamacpp-north/north-mini`;
  - `ollama/qwen2.5-chat-offload`;
  - `ollama/qwen2.5-coder-offload`;
  - `ollama/qwen3-offload`.
- `opencode providers list` shows credentials for `OpenCode Zen` and `ollama`, without secret values.
- `opencode models opencode` still returns `Provider not found: opencode`.
- sanitized global config inspection shows `disabled_providers` includes `opencode`, `anthropic`, `openai`, `google`, and `groq`.
- checked external env keys are unset: `OPENROUTER_API_KEY`, GitHub Models token candidates, Google/Gemini, Groq, HuggingFace, OpenAI, Anthropic.

Root cause for `Provider not found: opencode`:

```text
The provider is disabled by global OpenCode config, not absent from the installation.
```

With only an inline disabled-provider override, `opencode` models become visible:

```bash
OPENCODE_CONFIG_CONTENT='{"disabled_providers":["anthropic","openai","google","groq"]}' \
opencode models opencode
```

Observed free/test candidates included:

- `opencode/north-mini-code-free`;
- `opencode/deepseek-v4-flash-free`;
- `opencode/mimo-v2.5-free`;
- `opencode/nemotron-3-ultra-free`;
- `opencode/big-pickle`.

Selected model for first external smoke:

```text
opencode/north-mini-code-free
```

Reason: official OpenCode Zen free coding model, no new user account/key needed if the existing Zen credential is valid.

### OpenRouter Config Template Validation

At this point in the research timeline, no `OPENROUTER_API_KEY` existed in this shell, so no OpenRouter provider request was made by this inline-config path.

The non-secret inline config shape was validated with `opencode models openrouter-free` using `/tmp` XDG directories:

```bash
env XDG_DATA_HOME=/tmp/revo-opencode-acp-xdg-data \
  XDG_STATE_HOME=/tmp/revo-opencode-acp-xdg-state \
  XDG_CACHE_HOME=/tmp/revo-opencode-acp-xdg-cache \
  OPENCODE_CONFIG_CONTENT='{"provider":{"openrouter-free":{"npm":"@ai-sdk/openai-compatible","name":"OpenRouter Free","options":{"baseURL":"https://openrouter.ai/api/v1","apiKey":"{env:OPENROUTER_API_KEY}"},"models":{"cohere/north-mini-code:free":{"name":"Cohere North Mini Code free","limit":{"context":256000,"output":64000}},"poolside/laguna-xs-2.1:free":{"name":"Poolside Laguna XS 2.1 free","limit":{"context":262144,"output":32768}}}}}}' \
  opencode models openrouter-free
```

Result:

```text
openrouter-free/cohere/north-mini-code:free
openrouter-free/poolside/laguna-xs-2.1:free
```

Conclusion at that point: the custom provider/model config format was correct, but this inline-config path could not make a real OpenRouter request without `OPENROUTER_API_KEY`. Later OpenRouter TUI setup removed that blocker for the confirmed smoke runs.

### OpenCode Zen Free Smoke Attempt

Command:

```bash
OPENCODE_CONFIG_CONTENT='{"disabled_providers":["anthropic","openai","google","groq"]}' \
REVO_ACP_RESEARCH_MODEL=opencode/north-mini-code-free \
REVO_ACP_RESEARCH_ALT_MODEL=llamacpp-fast/qwen-coder-7b \
REVO_ACP_RESEARCH_TIMEOUT_MS=180000 \
pnpm run research:opencode-acp-sessions -- one-session
```

Artifact after harness redaction hardening:

```text
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T10-10-58-093Z-one-session.jsonl
/tmp/revo-opencode-acp-research-artifacts/2026-07-08T10-13-37-666Z-one-session.jsonl
```

Result:

- `initialize` passed;
- `session/new` passed;
- `session/prompt` reached the provider request path;
- the provider request failed with an invalid authorization header;
- the harness now redacts bearer values in JSONL artifacts and console diagnostics.

Conclusion:

The existing OpenCode Zen credential is present but not usable for a real external completion. This is a Zen credential setup issue, not an OpenCode config format or ACP startup issue. Later OpenRouter TUI runs confirmed external-provider behavior through a different provider.

### Harness Security Fix

While recording the failed external attempt, the research harness showed a redaction gap for generic `Bearer [REDACTED]` strings inside provider stderr/error messages.

Fix:

- extracted `scripts/research-opencode-acp/redaction.ts`;
- added `scripts/research-opencode-acp/redaction.test.ts`;
- redacts bearer authorization values in JSONL entries, ACP error messages, and formatted diagnostics before console summary output.

Focused verification:

```bash
node --import tsx --test scripts/research-opencode-acp/redaction.test.ts
node --import tsx --test scripts/research-opencode-acp/options.test.ts
```

Both focused tests passed.

### Follow-Up Actions

Useful next checks:

1. Re-authenticate OpenCode Zen, then rerun the `opencode/north-mini-code-free` smoke command above if Zen-specific behavior matters.
2. Keep `openrouter/cohere/north-mini-code:free` as the external-provider smoke model until another model has comparable evidence.
3. Run a bounded provider/model error probe separately from config-option acceptance.

Do not commit API keys or paste them into docs/config files.
