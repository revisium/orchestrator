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
