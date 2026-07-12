# ADR-0008 - Revo projects and versioned knowledge

- **Status:** Draft
- **Decision date:** 2026-07-06
- **Implementation status:** Prisma `RevoProject` and its engine `Branch.projectId` relation are present. User-facing
  repository resources, ADR/KB tables, proposal review/acceptance, provenance, and run context pins are not complete.
- **Specs:** [Revo project knowledge and migrations v1](../specs/revo-project-knowledge-migrations-v1.spec.md),
  [Revo Prisma and engine schema v1](../specs/revo-prisma-engine-schema-v1.spec.md),
  [execution plan v1](../specs/execution-plan-v1.spec.md),
  [resources, workspaces, and effects v1](../specs/resources-workspaces-effects-v1.spec.md)
- **Refines:** [ADR-0007](./0007-revo-storage-foundation.md)
- **Relates-to:** [ADR-0005](./0005-versioned-playbook-storage-and-revo-materialization.md)

## Context

Revo needs a user-visible project that groups repository resources, run history, accepted decisions, descriptive
knowledge, playbook overlays, settings, and future UI/API scope. The embedded Revisium engine also uses `projectId`,
but treats it as an opaque grouping key and does not own product project lifecycle.

The product must also distinguish durable meaning from one-run evidence. An agent-produced ADR or KB fact is a
proposal until a declared validation/review/gate flow accepts it. Chat history, embeddings, run events, and artifacts
are not authoritative project memory.

The current Prisma schema has `RevoProject` but no first-class `Repository` model. Repository identity and workspace
lifecycle therefore remain partly a Draft resource contract rather than a shipped project registry.

## Draft Decision

Use `RevoProject` as the only Revo product project registry. Each user project has one corresponding engine project
identity:

```text
RevoProject.id == Branch.projectId
```

ADR and KB are system-defined table groups within that engine project, not separate projects and not mirrors of the
Prisma project row. Revo-owned system meaning uses explicit reserved system project rows.

Use the embedded engine for reviewable, diffable, committed meaning:

- ADRs are normative project decisions.
- KB entries are descriptive project facts and knowledge with provenance and verification time.
- playbook/method remains reusable cross-project working method.
- run events, attempts, outputs, logs, and artifacts remain Prisma/file evidence from one execution.

Run-authored meaning follows one proposal-to-acceptance chain:

```text
run artifact
  -> proposal branch/revision
  -> validation and review
  -> human or declared policy gate
  -> accepted project revision
  -> explicit context pin for future runs
```

Agents read accepted revisions by default. Proposal content enters a run only when the selected pipeline explicitly
requests it. Future runs pin the selected accepted revision/hash in their `ExecutionPlan`; recovery never follows a
new knowledge HEAD.

Proposal metadata and document content have one authority each. A record such as `adr_proposals` tracks workflow
state, source run/artifact, branch/revision, reviewers, gate, and acceptance result; it must not hold a second
authoritative copy of the ADR body. The actual document is versioned once on its proposal branch and, after approval,
in the accepted revision.

KB facts record provenance such as source run/artifact, accepted revision, status, source location, and verification
time. Search/vector indexes are derived and rebuildable; they do not become the source of truth.

System-owned ADR/KB table templates and migrations are versioned with Revo releases. Users edit content through
declared product flows, not the built-in template definitions.

## Current and Target Boundary

Current shipped code includes the Prisma project registry, soft-delete/status fields, engine-required branch/revision
tables, and the `Branch.projectId` relation. Hot runs, tasks, attempts, inbox, events, outputs, and costs already remain
outside versioned knowledge.

ADR/KB table initialization, one-proposal-per-branch discipline, review/acceptance services, provenance fields,
future-run selection pins, repository resources, and attachment lifecycle remain Draft. This ADR stays Draft until
those contracts and implementation are reviewed as one coherent boundary.

## Draft target: Direct Cutover

The Draft target does not create mirrored Revisium `revo_projects` rows, separate ADR and KB engine projects, duplicate
ADR bodies, Revo-specific copies of engine migration state, fallback reads, or dual-write knowledge stores. Internal
alpha data does not require migration shims.

## Alternatives

- **Store product projects as Revisium rows or mirrors.** Rejected because lifecycle, repository relations, indexing,
  and API scoping are Prisma product concerns and mirrors create two authorities.
- **Create separate ADR and KB engine projects.** Rejected because one project identity plus separate table groups and
  proposal branches provides isolation without cross-project coordination.
- **Promote run output directly to accepted knowledge.** Rejected because provenance alone does not replace review and
  human/policy authority.
- **Store authoritative memory in embeddings or chat history.** Rejected because neither provides a reviewable,
  versioned source of truth.
- **Let users mutate system templates.** Rejected for the first contract because release migrations require stable,
  trusted definitions.

## Consequences

- Project CRUD and repository-resource contracts precede user-facing ADR/KB operations.
- Project knowledge services use engine branches/revisions; hot run services remain Prisma-backed.
- Proposal branches prevent unrelated run-authored changes from sharing one mutable draft.
- Accepted revision identity becomes an explicit route/context input.
- Derived search can evolve independently because provenance-bearing accepted rows remain canonical.
- Exact templates, migration commands, service APIs, validation, and failure behavior stay in the linked Draft specs.
