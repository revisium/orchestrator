# Agent output observability v1

Status: Current shipped behavior.

## Storage boundary

The only registration writer is the narrow `registerAgentOutputStream` primitive. It accepts exactly
`{runId, taskId, stepId, attemptId}` and validates each identifier as safe, non-empty, and at most 64 characters.
It derives `streamKey = agent-output-v1:<attemptId>` and
`eventId = event_<fnv1a64Hex(runId|agent_output_stream_registered|attemptId)>`. It creates an `events` row with
payload `{schemaVersion:1,attemptId,streamKey}` and actor `orchestrator`.

`appendRunEvent` is unchanged. A create conflict is resolved by reading the exact row: a missing row is a transport
error; an exact immutable match is idempotent success; any mismatch is a fatal row conflict. Storage sequence and
creation time are not part of the semantic match and are never public.

## Production flow

After successful context construction and before runner dispatch, registration happens for every physical attempt,
including retries. The reporter writes only to the derived per-attempt
DBOS key and emits a terminal status hint (`exited`, `failed`, `timed_out`, or `cancelled`). The retriable step does
not close the DBOS stream. Reporter write and flush failures remain observability-only.

## Read and watch

Discovery filters by run and event type, orders by storage sequence ascending, and strictly rejects malformed,
duplicate, or reordered registrations. The finite reader opens one stream per registration and interleaves events by
registration order, preserving each attempt's order. Zero registrations return an empty page. More than 64
registrations fails only the aggregate read/watch/activity operation with `OBSERVABILITY_CAPACITY_EXCEEDED`; it is not
an admission limit.

The opaque cursor is versioned base64url binary, run-bound, and at most 512 bytes. It stores a digest of the existing
registration prefix plus one high-watermark sequence and terminal bit per registration. Appended registrations add
zero-valued slots. Prefix removal, reordering, or substitution yields `STREAM_CURSOR_EXPIRED`; malformed encoding,
version, or slot values yields `VALIDATION_FAILURE`. Public MCP and GraphQL shapes remain unchanged.

Watch polls the raw run status after each bounded idle interval. `completed`, `failed`, `cancelled`, and `paused` are
terminal watch states; `paused` is the persisted raw status for the public blocked state. A terminal watch performs one
final drain of already-readable registered streams, then terminates after the next empty interval.

## Changelog

- 2026-07-13: per-attempt registration, strict discovery, bounded fan-in, and replay-safe cursors implemented.
