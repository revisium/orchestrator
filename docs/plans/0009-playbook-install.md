# Plan 0009 — Playbook install

> **Status: Ready to execute. Stage: D1-enabling.**
> **Depends on:** [0008](./0008-alpha-hardening.md), [`../vision.md`](../vision.md), and
> `../agents/adapters/revo/README.md` from the canonical playbook checkout.
> **Realizes:** `revo playbook install` imports the canonical agent playbook catalogs into Revisium as versioned
> meaning data. This enables route proposal and workflow-as-data later, but does not execute imported workflows.

## Scope

Implement:

```bash
revo playbook install <source> [--commit] [--dry-run] [--json]
```

The installer reads `playbook.json`, `catalog/roles.json`, and `catalog/pipelines.json`; validates them; maps
roles, pipelines, and playbook metadata into the control plane; and optionally commits the draft revision.

## Non-goals

- Do not implement workflow-as-data.
- Do not implement route proposal UI.
- Do not implement MCP, REST dashboard, `revo up`, or PR review-thread processing.
- Do not add a coding-agent runner.
- Do not use Codex or Claude Code adapter wrappers as runtime role definitions.
- Do not discover roles or pipelines by scanning markdown headings.
- Do not support network download or GitHub auth in this slice.

## Tasks

### 1. Control-plane schema

Add versioned `playbooks` and `pipelines` tables. Extend `roles` with optional playbook provenance fields. Imported
playbook roles use playbook-scoped row ids (`<playbook-id>/<role-id>`) so the existing executable runtime row ids
(`architect`, `developer`, `reviewer`, `integrator`, `pr-watcher`) remain untouched.

Verify:

```bash
pnpm run test -- src/control-plane/bootstrap-seed.test.ts
```

### 2. Versioned meaning access

Add an explicit versioned-meaning writer for `playbooks`, `roles`, and `pipelines`. Keep runtime
`createControlPlaneDataAccess` limited to draft runtime tables.

Verify:

```bash
pnpm run test -- src/control-plane/versioned-meaning.test.ts
```

### 3. Source, manifest, and catalog validation

Support a local playbook checkout path and an already-resolvable npm package. Reject unsupported remote sources
before any write. Validate the supported `schema_version` (currently `2`), catalog paths, duplicate ids, and required fields.

Verify:

```bash
pnpm run test -- src/playbook/manifest.test.ts src/playbook/catalog-loader.test.ts src/playbook/source-resolver.test.ts
```

### 4. Prompt and row mapping

Compose prompt-backed role prompts from `roles/<role>/ROLE.md` plus `roles/<role>/references/core.md` when present.
Map role rights to tools/runners using the canonical revo adapter rules. Import every catalog pipeline into the
new `pipelines` table.

Verify:

```bash
pnpm run test -- src/playbook/prompt-composer.test.ts src/playbook/import-mapper.test.ts
```

### 5. Installer and CLI

Wire `PlaybooksService` through the host-free Revisium module and expose `revo playbook install`.

Verify:

```bash
pnpm run test -- src/playbook/playbook-installer.test.ts src/cli/commands/playbook.test.ts src/cli/program.test.ts
```

### 6. Final gates

Run:

```bash
pnpm run typecheck
pnpm run lint:ci
pnpm run test:cov
pnpm run verify
```

Optional daemon smoke when standalone is available:

```bash
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
./bin/revo.js playbook install ../agents --dry-run
./bin/revo.js playbook install ../agents --commit
```

## Acceptance

- `revo playbook install ../agents --dry-run` validates the canonical playbook and prints deterministic planned
  changes without writing rows.
- `revo playbook install ../agents --commit` writes and commits versioned playbook, role, and pipeline data.
- Existing MVP workflow still loads the current runtime role rows; imported playbook role snapshots do not overwrite
  executable roles.
- Workflow-as-data remains later work.
- All local verification gates pass or skipped live smoke is reported with the concrete blocker.
