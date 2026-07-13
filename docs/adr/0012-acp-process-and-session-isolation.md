# ADR-0012 - ACP process and session isolation for MVP v1

- **Status:** Accepted
- **Decision date:** 2026-07-10
- **Specs:** [ACP runner session v1](../specs/acp-runner-session-v1.spec.md)
- **Refines:** [ADR-0004](./0004-runner-execution-contract.md) (runner execution contract)
- **Relates-to:** [ADR-0006](./0006-run-profiles-and-provider-neutral-pipelines.md) (run profiles and
  provider-neutral pipelines), [ADR-0007](./0007-revo-storage-foundation.md) (Revo storage foundation),
  [ACP experiment results](../research/acp-opencode/en/experiment-results-2026-07-08.md),
  [ACP experiment matrix](../research/acp-opencode/en/experiment-matrix.md)

## Context

ADR-0004 defines the runner contract, while ADR-0006 pins the runner, model, permissions, timeout, and other profile
bindings used by a pipeline node. An ACP runner also needs an explicit ownership boundary for the live process group,
stdio transport, ACP session, and top-level prompt created for each physical agent attempt.

An ACP process is daemon-like because it waits for protocol requests, but Revo does not treat it as a durable host
daemon in MVP v1. Its intended lifetime is one physical attempt. The logical pipeline step remains stable across
retries; each retry is a distinct physical attempt with a distinct `attemptId`.

The OpenCode ACP PoC proved that one process can host multiple sequential or concurrent sessions and that updates can
be routed by `sessionId`. That establishes technical feasibility, not an operationally safe pooling model. A shared
daemon creates a shared crash domain, and reliable per-session cancellation, permission handling, concurrency limits,
resource behavior under soak, and failure fan-out have not been demonstrated. The PoC also did not complete the
experiment matrix's two-process isolation and crash-domain experiment.

DBOS recovery adds one constraint to a literal one-to-one rule: an incomplete external-effect step may be re-executed
with the same physical `attemptId`. Revo can therefore guarantee exclusive live ownership and deterministic identity,
but it cannot promise exactly one operating-system spawn over the entire lifetime of an attempt.

## Decision

For MVP v1, each physical ACP agent attempt exclusively owns at most one live ACP invocation at a time. A normal
invocation owns one top-level ACP process group, exactly one ACP session, and exactly one top-level `session/prompt`.
The prompt may contain multiple internal model turns, tool operations, and permission exchanges; those protocol turns
do not create another Revo attempt or another top-level prompt.

```text
logical step
  -> physical attempt (attemptId)
      -> ACP invocation (invocationId, spawnNo)
          -> one live root process group
              -> one ACP session
                  -> one top-level session/prompt
                      -> zero or more internal model/tool/permission turns
```

An attempt may have no invocation when validation fails before spawn. Under normal execution it has one invocation.
If DBOS re-executes an incomplete external-effect step after host or process loss, the same attempt may receive a
replacement invocation with a higher `spawnNo`. The former runtime MUST first be known dead or fenced, and two
invocations for one attempt MUST NOT be live concurrently. The replacement creates a new process, session, and prompt;
it never reconnects to or resumes the former session. External effects remain idempotent by run, step, attempt, and
operation identity. `invocationId` is provenance and MUST NOT weaken deduplication keyed by `attemptId`.

A retry, human clarification, or rework is a new physical attempt and MUST create a new process, session, and prompt.
The process, session, and prompt MUST NOT be shared between attempts or steps. Cross-attempt session reuse,
`session/load`, and `session/resume` are not recovery mechanisms in MVP v1.

The invocation lifecycle is:

```text
validate and resolve inputs
  -> launch the root process group
  -> initialize ACP
  -> create one session
  -> apply the pinned model/session configuration
  -> send one top-level session/prompt
  -> stream updates and protocol requests
  -> record one terminal result or failure
  -> close the session best-effort
  -> stop and reap the process group
```

Ownership remains split along existing boundaries:

| Owner | Responsibility |
| --- | --- |
| DBOS adapter | Authoritative workflow progress, pinned retry policy, physical attempt identity, and replay inputs |
| Revo Prisma product DB | Product-facing attempt, invocation, provenance, event, cost, artifact-index, and terminal projections |
| Shared process executor | Root process group, PID/stdio handles, deadlines, timeout enforcement, kill escalation, reaping, and process artifacts |
| ACP runtime manager | ACP initialization, session configuration, one top-level prompt, update/request routing, terminal protocol reduction, and best-effort session close |

Neither DBOS nor the Revo Prisma product DB stores or attempts to recover a live PID, stdin, stdout, stderr, or
JSON-RPC connection. The
ACP runtime manager MUST reuse the shared process executor rather than implement a competing process supervisor. It
does not decide durable retry or pipeline advancement.

If Revo observes an ACP invocation exit, hang, transport loss, or invalid protocol stream, only its owning physical
attempt fails. DBOS applies the pinned retry policy and, if another attempt is allowed, starts that attempt with a new
process, session, and prompt. Replacement invocation with the same `attemptId` is limited to recovery of an incomplete
external-effect step whose terminal failure/result was not recorded. A valid result recorded durably before a later
cleanup failure remains the attempt result; the cleanup failure is operational diagnostics rather than a reason to
replay completed external side effects.

Startup and recovery reconciliation MUST detect an invocation whose durable desired or observed state no longer
matches a live runtime owned by the current host. The manager coordinates bounded orphan cleanup through the shared
process executor and reports ambiguous ownership. It may create a replacement invocation only after the old runtime is
dead or fenced; durable retry creates a new attempt instead.

## Rationale

The decision preserves the short-lived runner model used by Codex and Claude while making ACP's interactive session
explicit. It limits a daemon crash, provider hang, forced cancellation, or protocol corruption to one physical attempt
and avoids a shared session registry, cross-session failure fan-out, and pool health policy before those mechanisms
have evidence and product requirements.

The cost is accepted for MVP v1 because the measured PoC benefit of sharing a daemon is only technical feasibility;
startup savings, cache reuse, stable resource limits, and soak behavior have not been established.

## Alternatives

- **One shared ACP daemon with multiple sessions.** Rejected for MVP v1. It introduces a shared crash domain and
  requires proven session isolation, cancellation, permission routing, concurrency limits, health checks, and failure
  fan-out.
- **Reuse or resume a session across attempts or steps.** Rejected for MVP v1. It couples retries and pipeline nodes
  to mutable context and makes provenance, cancellation, and partial-side-effect recovery ambiguous.
- **Treat a replay spawn as a new attempt automatically.** Rejected for this ADR. DBOS may re-execute an incomplete
  external-effect step with the same deterministic attempt identity; replacement invocation identity records that
  reality without changing pipeline retry semantics.
- **Make DBOS the live process supervisor.** Rejected. Durable workflow state and ephemeral operating-system handles
  have different lifecycles; DBOS records workflow progress and retry policy, while the shared process executor
  supervises the process group and the ACP runtime manager coordinates the session protocol.
- **Keep a long-lived daemon per run or host.** Rejected for MVP v1. Its broader lifetime expands the failure domain and
  requires pooling, health, capacity, and orphan-reconciliation policy.

## Consequences

- Attempt and invocation identities are distinct: one attempt has zero or more sequential invocation records but no
  more than one live invocation.
- Every invocation that reaches prompt dispatch has a one-to-one audit relationship with its root process group, ACP
  session, and top-level prompt; earlier startup failure retains nullable process/session provenance.
- Process death, forced termination, and transport loss fail only the owning attempt.
- Every retry pays process startup cost and loses process-local cache and session context.
- Concurrent attempts consume separate process groups and require host-level capacity limits outside ACP.
- DBOS replay does not provide exactly-once semantics for external workspace side effects; replacement invocations
  retain the attempt-level idempotency key and add explicit invocation provenance.
- ACP support extends the shared process executor and the canonical result/error/artifact contracts; it does not
  introduce another executor or durable live-session store.

## Explicitly Deferred

- multi-session pooling and `1 ACP process / N sessions`;
- a shared or long-lived ACP daemon;
- process and general resource pooling;
- cross-attempt or cross-step session reuse, load, resume, or reconnect;
- more than one top-level prompt per invocation;
- pool-wide routing, capacity, health, soak, and process-failure fan-out policy.

## Review Triggers

Revisit this decision when at least one of the following is true:

- measured process startup or per-process resource cost violates an agreed latency, throughput, or concurrency budget;
- a product requirement needs session continuity or multiple top-level prompts across attempts or steps;
- ACP/OpenCode provides a proven reconnectable transport with defined recovery and side-effect semantics;
- bounded tests prove per-session cancellation and permissions, session isolation during process failure, concurrency
  limits, and leak-free multi-session soak behavior;
- a durable reconciliation design can safely distinguish and recover pooled process and session ownership;
- Revo's short-lived per-attempt runner invariant changes in a separate architectural decision.
