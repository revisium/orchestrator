# Revo data-access contract

This document defines the service boundary between transport, versioned meaning, runtime state, and execution. The
execution-plan and run-profile specifications remain Draft until final review and gates.

## Boundary

- MCP and GraphQL call application services; they do not read raw Revisium, Prisma, or DBOS tables.
- Revisium owns committed meaning: playbooks, role meaning, provider-neutral pipelines, routing policy, and run
  profiles.
- Prisma owns runtime rows: runs, tasks, attempts, events, inbox, outputs, and usage/cost provenance.
- DBOS owns workflow progress and durable waits/retries.
- Git/worktree and integration operations run through bounded application adapters.

Consumers receive domain objects and read-only projections, not storage payloads.

## Meaning reads and writes

Services load roles, pipelines, playbooks, routing policy, and run profiles from the committed Revisium head or an
explicit authoring scope. Role reads return meaning only. Pipeline reads return opaque graph semantics and execution
policy. Profile reads return exact launch bodies plus storage/lifecycle metadata.

Profile create/update/deprecate operations validate the same exact profile body used for launch. Updates use a revision
hash precondition and commit a new versioned meaning revision. A deprecated profile may be queried when requested but
cannot be selected for a new run.

No service loads a model mapping, applies a model alias, estimates price, or supplies a default model. Concrete model
ids are values in a selected profile. Runner manifests are resolved only during route planning and their non-secret
snapshot is pinned into the plan.

## Launch command boundary

`create_run` and `simulate_route` require `pipelineId` and exactly one of `profileId` or an inline profile body. They
share one resolver/compiler path:

1. resolve playbook and pipeline;
2. validate the selected stored/inline profile with the common validator;
3. normalize business parameters separately from `modelParams`;
4. materialize the provider-neutral graph;
5. resolve every graph `roleRef`/`scriptRef` obligation with canonical node-over-role precedence;
6. validate exact runner/provider/model/permission values against the runner manifest;
7. compile canonical plan bytes/digest and read-only route projection; and
8. return the result, or persist it before DBOS enqueue for `create_run`.

The response can include decoded pins for every agent and script slot. This decoded view is derived from the canonical
bytes and is not a second launch object. Scripts carry account aliases only; credentials remain in host-local runtime
configuration.

The absence of a live model-availability capability is intentional. The service neither probes nor claims availability
and does not add an unavailable-model stop condition.

## Runtime boundary

- Run/task/event/inbox/output/attempt/cost writes use Prisma services and are idempotent where DBOS replay can repeat a
  side effect.
- `TaskRun.routeDecision` stores the canonical route envelope and plan bytes/digest before workflow enqueue.
- Start, replay, resume, and recovery parse and verify the stored plan. They do not reread mutable profile, role,
  pipeline, or runner meaning.
- Runner/provider/model provenance is stored on attempts and cost rows. Token and cost values are nullable because they
  are runner reports. A reported cost, including zero, defaults to USD when no currency is reported; currency without a
  cost creates no cost record.
- Event and artifact payloads are secret-redacted before persistence.

## Transport adapters

MCP and GraphQL remain thin:

- schemas describe the same profile body and profile-source XOR;
- handlers delegate to the same service methods;
- stable domain errors are mapped at the boundary;
- no transport invents a runner/model default or a second override object; and
- no transport exposes credentials, price tables, model catalogs, or availability claims.

## Provider-neutral state-machine ownership

`pipeline-core` owns graph reduction and state transitions. It sees opaque role/script handles and dataflow, not model
configuration. Route planning owns exact execution binding. This separation keeps graph policy reusable across
profiles and prevents provider-specific pipeline copies.

## Fresh-alpha migration boundary

The exact contract is a direct internal-alpha replacement. Supported validation uses Prisma generation/validation and
fresh bootstrap/reset/reseed fixtures. No legacy rows are transformed, dual-written, or used as fallback authority.
