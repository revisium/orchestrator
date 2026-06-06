# Plans — build slices (work-orders)

A **plan** is a numbered, self-contained, step-by-step build instruction for **one slice** of the system, written
to be executed by a low-capability implementing agent. Plans are *how-to-build* work-orders — distinct from the
reference docs in [`../`](../) (the durable *what / why*).

## Convention

- **Naming:** `NNNN-short-kebab-title.md`, zero-padded, sequential (`0001-…`, `0002-…`). Numbers reflect intended
  build order; the order may shift.
- **One slice per plan.** A plan should be acceptance-testable on its own and not require reading the whole
  backlog.
- **Lifecycle:** `Not written` → `Draft` → `Ready to execute` → `Executed` (then it stays as a historical record;
  do not retro-edit a shipped plan — write the next one).
- **Each plan should contain:** scope + non-goals, prerequisites/verification, exact files to create, reference
  code, a **Verify** step per task, and a final acceptance test.

## Relationship to docs

- A reference doc (e.g. [`../repo-layer-contract.md`](../repo-layer-contract.md)) is the **design**; the matching
  plan turns it into **executable steps**. Several docs marked "Plan TBD" in [`../roadmap.md`](../roadmap.md) are
  designs whose plan is not written yet.
- Live status of every plan: [`../roadmap.md`](../roadmap.md).

> **Renumbered after the DBOS + NestJS pivot ([ADR-0001](../adr/0001-execution-engine-and-host.md)).** The
> pre-pivot plans (the dumb-loop era, old `0001–0018`) were dropped from the tree — they are preserved in `git
> log` and were superseded wholesale, not edited. This index starts fresh at `0001` for the MVP vertical slice.

## Index — MVP vertical slice

| Plan | Status |
| --- | --- |
| [0001-nest-host-and-dbos-bootstrap](./0001-nest-host-and-dbos-bootstrap.md) | Draft |
| [0002-revisium-nest-module](./0002-revisium-nest-module.md) | Draft |
| [0003-dbos-pipeline-workflow](./0003-dbos-pipeline-workflow.md) | Draft |
| [0004-human-gates-via-dbos-inbox](./0004-human-gates-via-dbos-inbox.md) | Draft |
| [0005-real-runners-and-integrator](./0005-real-runners-and-integrator.md) | Draft |
| [0006-end-to-end-mvp](./0006-end-to-end-mvp.md) | Draft |
