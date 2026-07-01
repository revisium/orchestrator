# ADR-0005 - Versioned playbook storage and Revo materialization

- **Status:** Draft
- **Decision date:** 2026-07-01
- **Specs:** [playbook storage v1](../specs/playbook-storage-v1.spec.md),
  [Revo playbook materialization v1](../specs/revo-playbook-materialization-v1.spec.md)
- **Relates-to:** [default playbook policy](../specs/default-playbook-policy.spec.md),
  [run dataflow v1](../specs/run-dataflow-v1.spec.md),
  [runner execution contract](./0004-runner-execution-contract.md)

## Context

Revo currently installs a playbook into the control plane as a small set of rows: `playbooks`, `roles`, and
`pipelines`. Role import composes a runtime prompt from the role markdown body plus `references/core.md`, stores the
result in `roles.system_prompt`, and records a source hash. This is enough for the bundled flat default playbook, but
it is not enough for the canonical `agent-playbook` shape.

The canonical playbook is a versioned method package, not just prompt text. It contains a manifest, role and pipeline
catalogs, role docs, role-local references, shared references, stack references, method docs, checklists, templates,
and generated adapter wrappers. Some of those roots are source data, some are derived adapter output, and some are
legacy archive content. A run needs a reproducible snapshot of the source data it was routed against, and Revo workers
need that snapshot inside the run worktree rather than reading a moving checkout of `agent-playbook`.

The target also needs a data model for relationships across playbook items. Pipelines reference roles; roles and
stacks reference documents; route-time selection resolves role, surface, stack, framework, practice, tooling, and
repo-overlay context. Revisium does not currently need self-relations for this. The first stable contract can store
relations as typed string/id references and validate that the referenced ids or paths exist inside the same immutable
snapshot.

## Decision

Adopt a hybrid playbook model:

- Markdown and JSON remain the authoring format.
- Installation produces an immutable `PlaybookVersion` snapshot in Revisium/control-plane storage.
- The snapshot stores raw document content, normalized metadata, content hashes, typed entity projections, and typed
  string/id relations.
- Route planning pins the selected `playbookVersionId`, `snapshotHash`, `contentTreeHash`, and per-step selected
  references in the durable route decision. Workflow execution, replay, and recovery read that pinned decision, never
  a live source checkout.
- Revo materializes the pinned snapshot into `.revo/playbook` inside each run worktree and writes route-time selection
  into `.revo/context`.
- Prompt-backed workers receive only the core role prompt plus an instruction to load selected references from
  their step-scoped `.revo/context/steps/<nodeId>/selected-references.json` and `.revo/playbook/**`.

The storage model is intentionally not a markdown-block taxonomy such as `DECISION[]`. Source labels like
`[DECISION]` can become optional extracted annotations later, but the load-bearing schema is the playbook package:
version, documents, roles, pipelines, stacks, references, templates, and their relations.

### Canonical source roots

The initial canonical runtime roots are:

- `playbook.json`
- `catalog/`
- `roles/`
- `pipelines/`
- `references/`
- `stacks/`
- `method/`
- `templates/`
- `checklists/`

Generated adapter roots such as `adapters/codex/materialized` and `adapters/claude-code/materialized` are not runtime
source data. They can be stored as auxiliary documents for audit if needed, but workers must not route from them.
`legacy/` is import-only archive content and is excluded from the default runtime bundle.

### Relation model

Relations are stored as validated records, not database self-relations. A relation names a source entity, target
entity or target path, relation type, and whether the relation is required for routing or materialization.

Examples:

- `pipeline:feature-development requires_role role:developer`
- `pipeline:feature-development optional_role role:qa-backend`
- `role:developer has_core_reference document:roles/developer/references/core.md`
- `stack:js-ts has_core_reference document:stacks/js-ts/references/typescript.md`

The importer validates that all required targets exist in the same `PlaybookVersion`. It does not require Revisium
self-relations or cross-table foreign keys to express this.

Per-run and per-step selected references are not `PlaybookRelation` rows because they are route decisions, not
immutable playbook facts. They live in the durable route pin and are materialized under `.revo/context`.

### Revo materialization

Each run worktree gets a `.revo` bundle:

```text
.revo/
  playbook/
    manifest.json
    playbook.json
    catalog/
    roles/
    pipelines/
    references/
    stacks/
    method/
    templates/
    checklists/
  context/
    run.json
    steps/
      <nodeId>/
        selected-references.json
```

The bundle manifest records the pinned playbook version, snapshot hash, included roots, excluded roots, per-file
hashes, and schema version. Runtime validates the manifest and the step-scoped selected-reference file before invoking
a worker.

## Alternatives

- **Flat prompt import only.** Rejected. It loses shared references, stack composition, templates, method contracts,
  and route-time selection evidence. It also makes runs depend on whatever text was concatenated into
  `system_prompt`.
- **Raw file copy only.** Rejected as the full storage contract. It is useful for `.revo` materialization, but it does
  not give Revisium a queryable schema for roles, pipelines, selected references, or compatibility checks.
- **Fully normalized markdown database with no raw files.** Rejected. The playbook is authored and reviewed as
  markdown. Removing raw source content would make audit, review, and future adapter generation worse.
- **Hybrid raw documents plus typed projections and relations. Chosen.** This keeps markdown reviewable while giving
  Revo stable, versioned, queryable data and a reproducible worktree bundle.

## Consequences

- The bundled default playbook should evolve from a flat prompt directory toward the same package shape used by the
  canonical playbook.
- Playbook installation gains additional versioned rows or document records beyond `playbooks`, `roles`, and
  `pipelines`.
- Route planning must pin the playbook snapshot and selected reference set.
- Worker prompts should shrink: role/core prompt stays in the prompt, conditional references move into `.revo`.
- Runtime failures must distinguish missing or corrupt materialized playbook context from agent reasoning failures.
- Adapter-generated files are no longer confused with source behavior in Revo runtime paths.
- The current flat bundled default playbook remains importable during migration. It may have role documents under
  `prompts/` and no role-local core references until the bundled playbook is reshaped.

## Validation

The implementing PR must be TDD-first. Required acceptance tests:

- importer stores all present canonical document roots and excludes generated adapter and legacy roots by default;
- importer validates role, pipeline, stack, and document relation targets inside one snapshot;
- runs pin `playbookVersionId`, `snapshotHash`, `contentTreeHash`, and per-step selected references in the durable
  route decision;
- worktree creation materializes `.revo/playbook/manifest.json`, `.revo/context/run.json`, and
  `.revo/context/steps/<nodeId>/selected-references.json`;
- selected references resolve to files present in the manifest;
- a stub-runner prompt-contract test proves the worker prompt instructs the role to read `.revo`, then opens every
  selected role/core/shared/stack reference using only worktree-local `.revo`;
- corrupt or missing `.revo` files fail before worker invocation with a materialization error.

The initial manual smoke on 2026-07-01 materialized 133 canonical documents into a temporary `.revo/playbook` bundle,
excluded `adapters` and `legacy`, and verified access with Codex subagents, Claude, and OpenCode. GLM returned a
provider-side 529 overload and did not produce a materialization verdict.

## Open Questions

- Whether auxiliary generated adapter artifacts should be stored in the same snapshot as non-runtime documents or in a
  separate audit namespace.
- Whether source-label extraction (`[DECISION]`, `[TODO]`, `[BEST-PRACTICE]`) should ship in v1 or remain a later
  annotation index.
- Whether `.revo/playbook` should materialize the full canonical snapshot on every run or only the selected subset
  plus dependency roots. The default should favor full canonical snapshot until bundle size becomes a measured problem.
- Which Revisium table names should hold document and relation projections.
