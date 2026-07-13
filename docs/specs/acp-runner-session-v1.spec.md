# ACP runner session v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** runner adapters (worker), DBOS adapter (pipeline), Revo Prisma runtime
- **Related ADRs:** [ADR-0012](../adr/0012-acp-process-and-session-isolation.md),
  [ADR-0004](../adr/0004-runner-execution-contract.md),
  [ADR-0006](../adr/0006-run-profiles-and-provider-neutral-pipelines.md),
  [ADR-0007](../adr/0007-revo-storage-foundation.md)
- **Related specs:** [runner manifest v1](./runner-manifest-v1.spec.md),
  [runner capabilities v1](./runner-capabilities-v1.spec.md),
  [runner result envelope v1](./runner-result-envelope-v1.spec.md)
- **Research evidence:** [OpenCode ACP experiment results](../research/acp-opencode/en/experiment-results-2026-07-08.md),
  [experiment matrix](../research/acp-opencode/en/experiment-matrix.md)

## Scope

This spec defines the MVP lifecycle and conformance contract for an ACP-based agent runner. It covers physical attempt
and invocation identity, root process ownership, ACP initialization, one session, one top-level prompt, streaming,
model/session configuration, result reduction, timeout, cancellation, cleanup, and DBOS replay.

It applies only to ACP agent attempts. It does not apply to deterministic script nodes. It does not define run-profile
selection, provider credentials, model pricing, UI, multi-session pooling, or production implementation structure
beyond the ownership boundaries below.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Current Contract

The shipped runners are short-lived CLI invocations. Codex starts an ephemeral process and does not expose resume;
Claude reports a provider session id but Revo records it only as transport metadata and does not resume it. Both
receive one composed context per `RunAgent` call and may perform internal model/tool turns before returning one
`AttemptResult`.

There is no production ACP/OpenCode adapter in the orchestrator today. Existing OpenCode entries in the runner
manifest, capability, and result-envelope drafts are target design only. The July 2026 PoC established that OpenCode
ACP protocol version `1` can initialize, create sessions, accept prompts, stream session updates, select a session
model, and return usage. It also established that multiple sessions share a process crash domain. It did not establish
production-safe permission handling, per-session cancellation, pooling limits, soak behavior, or exactly-once recovery.

The shipped route decision pins `modelLevel`, not the resolved `ModelProfile`; `runStep` currently loads the profile
after it starts. ACP replacement determinism requires the target route schema below to pin the resolved profile before
DBOS enqueue. Until that migration ships, ACP runner dispatch is not conformant with this spec.

DBOS may re-execute an incomplete external-effect step with the same deterministic physical `attemptId`. This spec
therefore defines an invocation identity below the attempt and guarantees at-most-one live invocation, not exactly one
operating-system spawn over the complete history of an attempt.

## Terminology

| Term | Meaning |
| --- | --- |
| Logical step | Stable graph/dataflow node execution identified by `stepKey`; unchanged across transient retries |
| Physical attempt | One retry-policy attempt with deterministic `attemptId` and 1-based `attemptNo` |
| ACP invocation | One attempt-scoped execution of the ACP protocol, identified by `invocationId` and `spawnNo` |
| Root process group | The top-level ACP child process and descendants owned by one shared-process-executor lease |
| ACP session | The session created by exactly one successful `session/new` during an invocation |
| Top-level prompt | Exactly one client request to `session/prompt` for that session |
| Internal turn | Model, tool, permission, or protocol exchanges inside the top-level prompt |

## Identity And Cardinality

For an ACP agent attempt:

```text
logical step
  -> physical attempt
      -> zero or more sequential invocation records
          -> at most one live invocation
              -> one root process group
                  -> one ACP session
                      -> one top-level session/prompt
```

Normative rules:

- Validation MAY fail before spawn. Such an attempt has no invocation and records `processRef = null`.
- Normal execution creates one invocation with `spawnNo = 1`.
- `invocationId` MUST be unique within the attempt and MUST include or be derivable from `attemptId` and `spawnNo`.
- Two invocations for the same attempt MUST NOT be live at the same time.
- An invocation record is allocated immediately before spawn. Spawn failure leaves `processRef = null`; later startup
  failure may leave `sessionId = null` or may create a session without dispatching a prompt.
- Each invocation MUST create at most one root process group, at most one ACP session, and at most one top-level
  `session/prompt`. An invocation that reaches prompt dispatch MUST have exactly one of each.
- An invocation MUST NOT call `session/new` or `session/prompt` a second time.
- A retry, human clarification, or rework MUST create a new physical attempt with a new process, session, and prompt.
- A session MUST NOT be reused by another attempt or step.
- MVP v1 MUST NOT call `session/load`, `session/resume`, or `session/fork`.

### Replacement invocation after replay

When DBOS re-executes an incomplete external-effect step with the same `attemptId`, the adapter MAY create a
replacement invocation with the next `spawnNo` only after the former process group is known dead or is fenced from
the target worktree. The replacement invocation MUST create a new process, session, and prompt. It MUST NOT reconnect
to the old stdio transport or resume the old session.

The replacement MUST preserve the pinned route, role, model profile, permissions, accepted verdicts, timeouts, and
manifest/protocol versions. External effects MUST retain the same attempt-level idempotency key where the protocol or
tool surface permits. `invocationId` is provenance and MUST NOT make a repeated attempt effect appear new.
Replacement invocation provenance MUST remain visible even when the final attempt row is shared.

## Protocol Driver Boundary

ACP is interactive and bidirectional. It cannot be implemented only as a pure `StdoutParser`. The runner manifest
therefore selects both:

- a `protocolDriver`, which sends requests, correlates responses, handles server requests, and reports activity;
- a pure `stdoutParser`, which reduces already captured ACP JSON-RPC messages to normalized events and a terminal
  result candidate.

The MVP ids reserved by this spec are:

```text
protocolDriver = acp-stdio-v1
stdoutParser   = acp-jsonrpc-v1
permissionStyle = acp-permission-v1
protocolVersion = 1
```

`acp-stdio-v1` MUST NOT own process creation, timeout enforcement, or durable retry. It uses the stdio transport and
activity tracker supplied by the shared process executor. `acp-jsonrpc-v1` MUST remain pure under the
`StdoutParser` contract.

An ACP manifest snapshot MUST pin `protocolDriver`, `stdoutParser`, and `protocolVersion` before DBOS enqueue. A
protocol-version mismatch MUST fail as a typed, non-retryable precondition error before `session/new`.

The target manifest shape is:

```jsonc
{
  "id": "opencode-acp",
  "protocolDriver": "acp-stdio-v1",
  "protocolVersion": 1,
  "stdoutParser": "acp-jsonrpc-v1",
  "permissionStyle": "acp-permission-v1",
  "kind": "cli",
  "binary": "opencode",
  "versionProbe": { "args": ["--version"] },
  "argTemplate": ["acp"],
  "schemaDelivery": "none",
  "promptDelivery": "protocol",
  "constraints": { "requiresNonEmptyProvider": true, "requiresNonEmptyModelId": true },
  "capabilities": {
    "provider": "provider-gateway",
    "authMode": "provider-config",
    "privacyClass": "profile",
    "supportsWorkspaceWrite": false,
    "supportsStructuredOutput": "prompt-only",
    "needsLivePreflight": true,
    "performsMerge": false,
    "producesWorktreeChanges": false
  }
}
```

`acp-permission-v1` compiles the portable role policy into decisions for ACP permission requests. It emits no CLI
flag. Workspace-write remains disabled until the permission conformance cases below pass. Promotion changes both
`supportsWorkspaceWrite` and `producesWorktreeChanges` to `true` in a new pinned manifest digest.

## Invocation Lifecycle

The ACP runtime manager performs these stages in order:

1. Resolve the worktree, role policy, accepted verdicts, timeout policy, manifest snapshot, and pinned resolved model
   profile.
2. Validate required binary/configuration and build the attempt-scoped invocation identity.
3. Ask the shared process executor to start the root process group and provide stdio/activity/artifact seams.
4. Send `initialize` with ACP `protocolVersion = 1`; reject an incompatible response.
5. Send exactly one `session/new` for the resolved worktree and record the returned `sessionId` as provenance.
6. Apply pinned session configuration as defined below.
7. Send exactly one `session/prompt` containing the composed Revo context and structured-result instruction.
8. Route updates and server requests only when their `sessionId` matches the invocation session.
9. Reduce one terminal result or failure into the canonical runner contracts.
10. Request `session/close` best-effort, then ask the process executor to terminate and reap the process group.

Any out-of-order response, duplicate terminal response, unknown response id, or mismatched `sessionId` MUST be retained
in redacted protocol artifacts and MUST fail the invocation as malformed protocol unless explicitly classified as a
safe ignorable notification by the pinned protocol driver version.

## Model And Session Configuration

The target route schema pins a resolved `ModelProfile` before workflow enqueue. The OpenCode ACP adapter derives the
session model selector by joining the pinned profile fields as:

```text
selector = ModelProfile.provider + "/" + ModelProfile.modelId
```

`modelId` MAY contain additional `/` segments and they MUST be preserved. For example:

```text
provider = openrouter
modelId  = cohere/north-mini-code:free
selector = openrouter/cohere/north-mini-code:free
```

Both `provider` and `modelId` MUST be non-empty after trimming. Validation fails before spawn otherwise.

The adapter MUST NOT silently replace the selector with the current OpenCode default. It MUST record the resolved
selector in invocation provenance. Existing OpenCode configuration and credentials are inherited by the child process;
Revo MUST NOT copy secrets into durable state or rewrite provider credential files.

The adapter MUST set the advertised session `model` config option before the prompt. Explicit `mode` or `effort`
values MAY be read from pinned `ModelProfile.params`; when present, each MUST be applied only if the initialized
session advertises that option. An explicitly requested but unsupported option is a typed non-retryable configuration
failure. Absence of `mode` or `effort` means "use the OpenCode configured default" and is not an error.

Provider/model health checks are optional preflight capabilities. A loopback URL or port MUST come from configuration;
it MUST NOT be hardcoded into the runner or this spec. Successful configuration acceptance does not prove inference
success, so the normal runner deadlines remain mandatory.

## Prompt And Internal Turns

The top-level prompt is the already composed `RunAgent.context`, the durable `Attempt-Id` instruction, and the
canonical result-envelope instruction. Schema/tool registration, ACP initialization, config-option calls, permission
responses, and tool results do not count as additional top-level prompts.

The invocation MAY contain multiple internal model turns, tool operations, and permission exchanges before the
top-level prompt completes. Provider-side hidden retries MAY also occur. They remain part of one invocation and MUST
be reflected in available usage, operation, and diagnostic records rather than represented as new Revo attempts.

## Streaming And Result Reduction

The protocol driver MUST route all session updates by exact `sessionId` and report parsed activity to the shared
activity tracker. Raw stdout/stderr and protocol artifacts MUST use existing bounded, secret-redacted artifact rules.

For MVP v1, OpenCode ACP is `prompt-only` under the runner result-envelope spec. The adapter MUST concatenate terminal
agent text chunks for the invocation session and extract one canonical `AgentResultEnvelope`. A successful
`session/prompt` response or `stopReason=end_turn` is not a valid Revo result by itself. Missing, malformed, fenced, or
prose-wrapped output follows the existing prompt-only extraction and `revo.ResultInvalid` contract.

The adapter MUST lift the envelope's top-level `verdict` into `AttemptResult.verdict`, preserve `output`, normalize
`nextSteps`, and map `needsHuman`, `lesson`, artifacts, usage, and reported cost through the shared runner helpers.
Reported provider cost takes precedence over token-derived cost. Session usage updates are observability; terminal
usage and cost reduction MUST be deterministic for a fixed captured protocol artifact.

OpenCode MUST NOT be promoted to `tool-call` until a separate live conformance test proves forced `submit_result`,
strict argument handling, and deterministic fallback behavior through ACP.

## Permissions And Cancellation

Server permission requests MUST be correlated to the invocation session and mapped from portable role rights,
`allowedTools`, and `permissionMode`. Unknown permission requests fail closed. A runner MUST NOT advertise
workspace-write support until allow, deny, timeout, malformed request, and tool-scope conformance cases pass.

MVP cancellation is process-boundary authoritative:

1. stop accepting new protocol work;
2. request `session/close` best-effort when the transport is responsive;
3. ask the shared process executor to apply bounded termination and process-group kill escalation;
4. reap and finalize artifacts.

The adapter MUST NOT depend on `session/cancel`, because the researched OpenCode ACP version did not expose a working
method. Failure or timeout of `session/close` MUST NOT prevent process termination.

## Timeout, Failure, And Cleanup

The shared process executor owns idle and wall-clock limits. ACP bytes, parsed notifications, responses, heartbeats,
and explicit tool-operation start/finish events count as generic activity under the runner contract. The ACP runtime
manager MUST NOT implement a competing timer or kill path.

Failure classification:

| Condition | Classification |
| --- | --- |
| Missing binary, incompatible protocol version, unsupported explicit config | Non-retryable precondition/configuration failure |
| Authentication, permission policy, malformed result | Non-retryable unless a durable human recovery gate changes inputs |
| Provider timeout, rate limit, process crash, idle or wall-clock timeout | Retryable candidate under the pinned runner policy |
| Context overflow | Typed model/context failure; retryability requires changed context/model inputs |
| Malformed JSON-RPC, duplicate terminal response, mismatched session | Protocol failure with full redacted diagnostics |
| Cleanup failure after durable valid result | Operational diagnostic; MUST NOT invalidate or replay the valid result |

On every path, process artifacts MUST include the invocation identity, command metadata without secrets, timing,
termination evidence, bounded stdout/stderr tails, and redacted protocol diagnostics where available.

## Durable Records And Ownership

DBOS owns authoritative workflow progress, retry policy, and the deterministic physical attempt. The Revo Prisma
product DB stores product-facing projections for attempts and invocation provenance. Revisium remains the owner of
versioned control-plane meaning such as roles and model profiles. The target invocation projection contains at least:

```text
runId, stepKey, attemptId, attemptNo,
invocationId, spawnNo,
runnerId, manifestDigest, protocolDriver, protocolVersion,
modelProfile snapshot or pin, resolved model selector,
processRef?, sessionId?, status,
startedAt, finishedAt,
failureKind?, artifactRefs[], usage/cost summary
```

`processRef` and `sessionId` are audit/provenance values, not durable live handles. No durable component stores a live
PID, pipe, socket, or resumable ACP client object.

## Validation

Required contract coverage:

- pre-spawn failure produces an attempt with no invocation/process reference;
- spawn/startup failure records the invocation with nullable process/session references and no duplicate cleanup;
- normal execution creates one invocation, process group, session, and top-level prompt;
- a second `session/new` or `session/prompt` is rejected;
- internal tool/model turns do not create another attempt or prompt;
- updates for a different `sessionId` fail closed and are preserved in redacted diagnostics;
- model selectors preserve nested model-id segments;
- explicit unsupported `mode`/`effort` fails before prompt;
- malformed or missing result reaches the canonical invalid-result seam;
- timeout and cancellation use process-group termination even when session close hangs;
- DBOS re-execution creates a sequential replacement invocation only after the prior runtime is dead or fenced;
- a transient retry creates a new attempt, invocation, process, session, and prompt;
- cleanup failure after a durable valid result does not replay the result-producing invocation;
- permission requests deny unknown operations and workspace-write remains disabled until full conformance passes;
- raw artifacts redact credentials, authorization headers, environment secrets, and provider tokens.

Live provider/model smoke is manual evidence and MUST NOT be a unit-test dependency. Deterministic protocol fixtures
and fake process executors own automated coverage.

## Compatibility And Deferred Work

This is a target Draft spec. It adds no shipped runner id until the ACP adapter and its conformance suite land. Existing
Claude, Codex, script, and stub behavior is unchanged.

Deferred beyond MVP v1:

- multi-session daemon pooling;
- session load, resume, fork, or cross-attempt continuity;
- more than one top-level prompt per invocation;
- shared process capacity scheduling and pool health;
- provider-specific automatic retry control;
- `tool-call` structured-output promotion;
- durable live-session recovery.

## Changelog

- 2026-07-10: Initial Draft aligned with ADR-0012 and the OpenCode ACP PoC.
