# VERIFICATION.md — repo gates

## Required gate

```
pnpm verify
```

Runs in order: `typecheck` → `lint:ci` → `test:cov`. All must pass before merging.

## Other gates

| Command | When to run |
|---|---|
| `pnpm build` | Validate compiled output before publish/deploy |
| `pnpm test:e2e` | Full end-to-end stack (requires a live Revisium + DBOS env) |
| `pnpm ci:local:sonar` | Static analysis — run before opening a PR that touches architecture boundaries |

## TDD and e2e test quality (HARD RULE)

Behavior changes must start with a failing test before implementation changes. Prefer e2e first when the behavior
crosses a public boundary: MCP tools, GraphQL, CLI, DBOS/Revisium workflow state, runner dispatch, playbook
installation, default pipelines, or real host lifecycle. Add focused unit tests after the e2e test to pin pure
reducers, validators, classifiers, and edge cases.

Do not accept tests that pass only because their fixtures are incomplete. Fixtures must be production-shaped for every
field the code reads, including derived fields such as `readinessVerdict`, `nextAction`, workflow cursors, compacted
MCP payloads, join arrivals, retry metadata, and default-playbook route bindings. If a test intentionally omits a
field, assert that omission is the behavior being tested.

Every e2e or integration test for a decision path must assert the reason, not only the terminal status. Check the
verdict/action/evidence, emitted event, gate summary, compact response field, or persisted output that caused the
route. A test that only asserts `succeeded`, `blocked`, or "returned something" is incomplete for new behavior.

Consensus, branching, and approval flows must cover positive and negative cases:

- all reviewers approve or return allowed pass verdicts;
- exactly one reviewer rejects, blocks, or asks a question;
- both reviewers reject, block, or ask questions;
- branch order does not change the verdict;
- every branch output that should reach the join is recorded before routing.

MCP and GraphQL compact-response tests must prove both sides of the contract: large/raw payloads are removed, and
actionable semantic fields remain visible. When compacting readiness or feedback, preserve the fields that explain
`verdict` and `nextAction`.

Tests for removed or deprecated tools must assert absence from the registered surface and update specs/docs in the same
change. Do not leave README/spec references to tools that are no longer registered.

## Comment policy (HARD RULE)

DELETE BY DEFAULT. A comment is justified only when it carries information the code cannot convey on its own.

**Delete:**
- Comments that restate what the code does (the name, type, or test already says it).
- Pure pointers to plans, slices, consensus numbers, or section tags with no in-repo target.
- Commented-out code.
- Decorative banners (`// ─────`).
- Anything a name, type signature, or test makes obvious.

**Keep** only a comment whose removal would force a reader to re-derive a non-obvious invariant:
- The non-obvious WHY — a hidden constraint, an external quirk, a subtle invariant.
- Concurrency, replay, or idempotency hazards.
- Non-local correctness guarantees (e.g. "caller must hold lock X").
- Behavior-affecting distinctions the type system cannot enforce.
- Defensive handling where a type lies at runtime.
- Workarounds for external system quirks (DBOS sealed invariant, GitHub API edge cases).
- Security or hot-path performance constraints.

**When keeping a comment, also:**
- Strip dead-pointer / crypto-tag tokens: `§N` (unless it sits next to a valid in-repo doc path like `docs/specs/`), crypto rule tags (`G9`, `B5`, `CR-C`, `C2`, …), `NNNN #N` plan-refs, `plan NNNN`, `slice N`, `consensus MN`, `audit §X`. Keep ADR refs (`ADR 0006`).
- Fix punctuation minimally. Do NOT reword the explanation.

**Enforcement:** the `local/no-dead-pointers` eslint rule (see `eslint-local-rules/no-dead-pointers.js`, wired into `eslint.config.mjs`) scans comments in `src/**/*.ts` (excluding `*.test.ts` and `src/e2e/**`) and fails `pnpm lint:ci` on any banned token. The no-restating judgment above is enforced in review.

> Note: the tree is intentionally comment-free by this policy. Historical comments (including load-bearing WHY) are recoverable via `git log` / `git blame`.
