# ADR-0005 - Versioned playbook storage and Revo materialization

- **Status:** Draft
- **Decision date:** 2026-07-01
- **Implementation status:** Current catalog import and built-in graph bootstrap do not implement this end-to-end
  target.
- **Specs:** [playbook storage v1](../specs/playbook-storage-v1.spec.md),
  [Revo playbook materialization v1](../specs/revo-playbook-materialization-v1.spec.md),
  [execution plan v1](../specs/execution-plan-v1.spec.md),
  [script runtime v1](../specs/script-runtime-v1.spec.md),
  [resources, workspaces, and effects v1](../specs/resources-workspaces-effects-v1.spec.md)
- **Refines:** [ADR-0002](./0002-data-driven-pipeline-state-machine.md)

## Context

Revo currently imports `playbooks`, `roles`, `pipelines`, and run-profile metadata into the control plane. The
product-owned default playbook includes executable `template_json` graphs and is the bootstrap source for shipped
runs. The canonical `@revisium/agent-playbook` package is different: its current catalogs describe discovery, roles,
route gates, runner bindings, and execution-policy recommendations, but do not contain an executable graph. It is not
runnable by the shipped Revo importer end to end.

The canonical package contains more than prompts: method documents, roles, pipelines, references, stacks, checklists,
templates, catalogs, and generated platform adapters. A run must not depend on a moving package checkout, runtime LLM
parsing of pipeline prose, or mutable registries during recovery.

The current Prisma `TaskRun.routeDecision` pins a materialized built-in graph/profile decision, but it is not yet a
complete immutable record of every execution-affecting playbook document, runner/script capability, resource,
selected context revision, and implementation digest.

## Draft Decision

Adopt one compiled playbook authority chain:

```text
canonical authoring package
  -> installer/compiler validation
  -> immutable PlaybookVersion
  -> route-time fully resolved ExecutionPlan
  -> selected worktree playbook/context materialization
```

Markdown and JSON remain human-reviewable authoring source. A runnable package also declares a validated
machine-readable executable graph and all required capability/artifact references. Runtime must not derive executable
topology by asking an LLM to interpret `PIPELINE.md`.

Installation validates package paths, documents, catalogs, executable graph content, relations, and capability
references, then records one immutable `PlaybookVersion`. The built-in product graph is bootstrap data until it is
authored through that same package contract; it must not become a competing canonical authoring source for
`@revisium/agent-playbook`.

Route planning resolves the selected graph, roles, runner capabilities, scripts/effects, policies, resources,
artifact contracts, and selected context into an immutable `ExecutionPlan`. DBOS workflow execution, replay, and
recovery consume that pin and do not read mutable package HEAD, a source checkout, latest control-plane rows, or a
live capability registry.

Materialization places only the pinned playbook/context needed by workers inside the selected worktree. Materialized
files are derived execution inputs, not a new authoring source.

If executable graph paths, effect capability references, artifact schemas, or future fragment references extend the
current `playbook.json`/catalog contract, the authoring schema version changes explicitly. Schema v2 must not acquire
silent optional semantics that old importers cannot validate.

Reusable graph fragments are a later playbook concept. Trusted custom scripts are build/install-time package code,
not arbitrary untrusted runtime snippets. Neither receives a public plugin API until the internal graph, script, and
execution-plan contracts stabilize.

## Direct Cutover

This internal alpha redesign uses direct replacement:

- no legacy role/pipeline aliases;
- no fallback reads from old rows or source files;
- no dual-write compatibility storage;
- no filesystem scanning as hidden discovery;
- no runtime LLM interpretation of canonical Markdown;
- no public stub-vs-live product route.

Current behavior remains documented until replacement lands, but it does not shape the target as a compatibility
requirement.

## Alternatives

- **Keep flat role/pipeline row import.** Rejected because it omits the package documents, executable graph contract,
  cross-item relations, and full replay inputs.
- **Copy the source tree into every run and read it live.** Rejected because source files are mutable and do not prove
  validation, selection, or capability resolution.
- **Normalize all Markdown into database-only prose.** Rejected because Git-reviewed authoring remains valuable and
  raw source is needed for audit/materialization.
- **Let the built-in product graph and canonical package remain co-authoritative.** Rejected because fixes and policy
  would drift between two owners.

## Consequences

- Package installation becomes compilation, not row copying.
- `PlaybookVersion` is immutable; project/user customization produces an explicit versioned overlay or derived
  version rather than mutating imported rows with reconciliation rules.
- `ExecutionPlan` becomes the sole execution/recovery input for execution-affecting meaning.
- Worktree context can be verified against pinned hashes before invoking a worker.
- Import and route failures distinguish invalid authoring content, unresolved capabilities, corrupt materialization,
  and worker failure.
- The current canonical package needs a schema-versioned executable graph declaration before it is Revo-runnable.

## Open Questions

- Which authoring schema version first declares the executable graph and its effect/artifact references?
- Does the first compiler emit one graph artifact per pipeline or one package-wide graph bundle?
- What is the smallest materialized reference subset that remains easy to audit without making selection brittle?
- Which customization use case is first: project overlay, user overlay, or derived package version?

Exact records, hashes, validation failures, and materialization file shapes remain owned by the linked Draft specs.
