# ACP + OpenCode: Documentation Review

- **Date:** 2026-07-08
- **Status:** Research notes before ADR. This is not an architecture decision or implementation specification.

## Goal

Capture facts from ACP/OpenCode documentation before integrating it into Revo. Revo code is not analyzed here, except for the already known spike context: `opencode acp` starts, `provider/model` is passed through OpenCode config, and streaming chunks arrive and are parsed.

## Sources

| Source | Link | Used for |
|---|---|---|
| ACP Transports | https://agentclientprotocol.com/protocol/v1/transports | JSON-RPC transport, stdio, Streamable HTTP, custom transports |
| ACP Session Setup | https://agentclientprotocol.com/protocol/v1/session-setup | `session/new`, `session/load`, `session/resume`, `session/close`, session meaning |
| ACP Schema | https://agentclientprotocol.com/protocol/v1/schema | Methods, capabilities, update/error/usage surface |
| OpenCode ACP Support | https://opencode.ai/docs/acp/ | How `opencode acp` starts, stdio JSON-RPC subprocess |
| OpenCode CLI | https://opencode.ai/docs/cli/ | OpenCode CLI surface |
| OpenCode Config | https://opencode.ai/docs/config/ | Config/provider/model/context compression |
| OpenCode source: ACP service | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/service.ts | ACP implementation details when public docs are silent |
| OpenCode source: ACP config options | https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/config-option.ts | `session` config option implementation details |

## Documented ACP Facts

ACP uses JSON-RPC. The official docs describe `stdio` transport and draft `Streamable HTTP`. `stdio` is not the only possible transport because the specification allows custom transports, but `stdio` is the baseline recommended option.

In `stdio` mode, the client starts the agent as a subprocess. The agent reads JSON-RPC from `stdin` and writes JSON-RPC to `stdout`; logging is allowed through `stderr`. This implies an important constraint: if the client process dies, its pipe to the child process is lost. The ACP documentation does not provide a general process-level reconnect over `stdio`.

An ACP session is described as a distinct conversation/thread between client and agent. Each session has its own context, conversation history, and state. `session/new` creates a session and returns a unique `sessionId`.

ACP documents `session/load` and `session/resume` when the agent declares the corresponding capabilities. `session/load` restores a session with history replay through `session/update`; `session/resume` restores it without replay. This is session-level restoration, not a universal transport-level pipe reconnect.

ACP documents `session/close`: the agent should cancel current work for the session and release resources. It is not a process shutdown API.

The reviewed ACP documentation does not define a standardized `start`, `stop`, `shutdown`, `health`, `heartbeat`, `ping`, or `status` API for the agent process.

ACP does not require fixed `provider`, `model`, or `effort` fields in `session/new` or `session/prompt`. Model/mode/effort belong to session config options or implementation-specific behavior in a concrete agent.

## Documented OpenCode ACP Facts

OpenCode publicly documents startup through `opencode acp`. The editor/client should start OpenCode as an ACP-compatible subprocess that communicates over JSON-RPC through `stdio`.

OpenCode docs confirm that ACP mode supports OpenCode capabilities: built-in tools, custom tools, slash commands, MCP servers from OpenCode config, project-specific rules from `AGENTS.md`, agents, and the permissions system. This matters for Revo: the project `cwd` can sharply change context size and agent behavior.

OpenCode public documentation covers config/provider/model/baseURL/API key in detail, but barely documents:

- long-running ACP daemon as a separate server;
- reconnect after losing `stdio`;
- multiple ACP sessions in one process;
- parallel ACP sessions;
- exact ACP usage/cost event shape;
- exact context overflow behavior through ACP.

OpenCode source shows more than the public docs: the ACP implementation declares capabilities such as load/list/resume/close/fork and session config options for model/effort/mode. Treat this as a fact about the current implementation, not a public user-facing API guarantee.

## What The Docs Do Not Close

The documentation does not answer the following questions strictly enough:

- Whether one `opencode acp` process can safely be used for several Revo steps.
- Whether prompt concurrency across sessions is guaranteed.
- What happens when Revo/client dies while the `opencode acp` subprocess remains alive.
- Whether a new Revo process can reconnect to an already running `opencode acp` process through `stdio`.
- How OpenCode behaves with different model/effort/mode values across sessions in one process.
- What session limit per ACP process is safe.
- How to build health/reconciliation correctly for OpenCode ACP.

## Preliminary Revo Implications

For v1, `opencode acp` must not be treated as a fully reconnectable daemon/server based on documentation alone. Over `stdio`, it is a subprocess tied to the client pipe.

The documentation supports the idea of an `AcpManager`, but does not prove that pooling is needed. The safer initial hypothesis is:

```text
1 ACP process / 1 session / 1 step-or-attempt
```

That scope is simpler for ownership, cleanup, cancellation, DBOS state, and failure isolation.

Using one ACP process for multiple sessions may be useful, but only after PoC evidence:

- events must route reliably by `sessionId`;
- model/effort/mode must be session-scoped;
- cancellation must not break neighboring sessions;
- process failure must have an understandable blast radius;
- DBOS reconciliation must know which sessions were lost.

## Checks Needed Before ADR

The documentation gives direction, but the ADR must also rely on experiments:

1. One `opencode acp`, one session, one prompt.
2. One `opencode acp`, two sessions sequentially.
3. One `opencode acp`, two sessions in parallel.
4. Different model/effort/mode values across sessions.
5. `session/load` and `session/resume`.
6. `session/cancel`.
7. `session/close`.
8. Permission request flow.
9. Context overflow.
10. Provider/API error.
11. Client death/reconnect behavior.
