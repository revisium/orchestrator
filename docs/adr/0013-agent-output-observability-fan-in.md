# ADR-0013: Per-attempt agent output observability fan-in

Status: Accepted.

## Decision

Persist immutable per-attempt stream registrations in the existing run event log, then read DBOS output through
those registrations. Each attempt owns `agent-output-v1:<attemptId>`. A strict dedicated registration primitive
owns its deterministic event identity and conflict semantics; the general event append primitive is not modified.

The public finite read and watch operations retain their existing result shapes. They discover registrations in event
sequence order, preserve per-attempt order, and use a bounded opaque cursor rather than exposing storage chronology.
The fixed aggregate capacity is 64 registrations per read operation. This is a read capacity, not a registration
limit.

## Consequences

Registration is a durable admission gate before runner execution. Agent reporter failures cannot change workflow
outcomes. DBOS stream closure is not part of a retriable step because retries and recovery must remain able to emit
terminal status events. Late retries are discovered by watch polling through the same finite reader. Persisted `paused`
is the raw form of the public blocked terminal state; watch final-drains registered streams and then terminates after
an empty poll.

The system does not provide a fake global event chronology, shared-stream fallback, dual writes, or a retry hotfix.
