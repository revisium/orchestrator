# ADR-0011 - System script runtime and trusted extensions

- **Status:** Draft
- **Decision date:** 2026-07-11
- **Spec:** [Script runtime v1](../specs/script-runtime-v1.spec.md)
- **Refines:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md),
  [ADR-0004](./0004-runner-execution-contract.md)
- **Relates-to:** [ADR-0010](./0010-run-resources-and-workspace-planning.md),
  [run dataflow v1](../specs/run-dataflow-v1.spec.md),
  [human gates v1](../specs/human-gates-v1.spec.md)

## Context

The shipped script path is a workflow-local registry of broad operations backed by an integration service that mixes
Git preparation, commits, pushes, pull-request publication, readiness waiting, review-thread mutation, and merge. Some
operations both observe and mutate GitHub. DBOS registration is wired separately, and generic execution contains
special cases for concrete script and node ids.

That shape hides schemas, permissions, retry safety, idempotency, and audit behavior. It also gives future extensions no
stable internal contract.

## Decision

Adopt a bounded system-script runtime. Every operation is an explicitly registered `ScriptDefinition` created with
`defineScript`. A definition combines:

- a serializable, versioned manifest;
- runtime input and result schemas;
- one handler;
- trusted build-generated handler identity;
- a stable definition digest over manifest, schemas, and packaged-handler digest.

The manifest declares identity, schema references, optional declarative verdict extraction, resource access, credential
kinds, timeout, retry eligibility, idempotency, redaction, and effects. Pipeline refs select an explicit `(id, version)`;
the plan additionally pins the installed build/definition digest. Handler code and executable schema objects are
trusted host code and are never stored in playbook data. Recovery resolves only an installed definition with the exact
pinned identity and digest and fails closed on mismatch.

Built-ins are registered explicitly at host startup. A future trusted build-time plugin package may call the same
definition and registration API during startup. Runtime installation, downloaded code, untrusted plugins, and a public
SDK are out of scope.

The companion specification fixes the V1 package-wide build-digest generator, Git commit trailer, GitHub managed-PR
and review-reply markers, pull-request metadata revision, and startup exact-code pin audit. Those are accepted delivery
mechanisms, not choices delegated to implementation slices.

V1 operation ids are Git- and GitHub-explicit, for example `script:git/*` and `script:github/*`. Implementations may
share private clients, but there is no public multiplexer, mode switch, or `delivery/*` facade.

Observation, waiting, and mutation are separate concerns. A GitHub readiness operation returns one snapshot and never
waits or mutates. The pipeline owns bounded wait/loop topology. Mark-ready, thread replies/resolution, publication, and
merge are separate auditable operations.

Worktree preparation and release are not scripts. ADR-0010 owns them as resource lifecycle.

Generic script execution dispatches by the pinned definition and validates declarations; it must not branch on
concrete script ids or node ids. Scripts do not route the pipeline, resolve human gates, choose runners, or load mutable
playbook/profile data.

Handlers receive bounded filesystem/Git/GitHub clients assembled from the manifest, node grant, resource plan, and
pinned aliases. They do not receive a raw workspace path, shell, process environment, token resolver, generic network
client, Prisma, or DBOS. Write operations must reconcile provider/Git state across the crash window between an external
effect and durable DBOS result recording; a deterministic Revo key alone is not sufficient.

## Alternatives

- **Keep one integrator with a mode field.** Rejected because it recreates hidden per-mode permissions, schemas, and
  replay rules behind one operation.
- **Store handler source in playbook data.** Rejected because playbooks are data, while executable code is a trusted
  host supply-chain concern.
- **Make readiness polling one long script.** Rejected because waiting belongs to durable graph/DBOS progress and
  observation must remain mutation-free.
- **Model scripts as deterministic runners.** Rejected for the target contract. Runner selection and script operation
  selection are separate registries and capability domains.
- **Ship a public plugin SDK now.** Rejected until the built-in contract and host-startup trust model are proven.

## Consequences

- Each operation has a local contract, schemas, handler, tests, and documentation.
- Central execution policy can validate access, enforce timeouts/retry/idempotency, redact evidence, and emit uniform
  events.
- Registry conflicts and digest mismatches fail before side effects.
- Host startup fails before recovery when a resume-eligible plan pins executable code absent from the sealed registry.
- GitHub writes become individually auditable and readiness snapshots become reusable pipeline data.
- The bundled graph and old script registry must switch atomically; aliases and fallback adapters are not retained.
- Trusted plugin loading remains a later host-startup feature using the same internal definition API.
