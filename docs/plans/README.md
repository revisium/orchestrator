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

## Index

| Plan | Status |
| --- | --- |
| [0001-revisium-daemon-and-bootstrap](./0001-revisium-daemon-and-bootstrap.md) | Executed |
| [0002-control-plane-data-access](./0002-control-plane-data-access.md) | Ready to execute |
| [0003-create-run-workflow](./0003-create-run-workflow.md) | Ready to execute |
