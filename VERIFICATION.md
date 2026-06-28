# VERIFICATION.md — repo gates

## Required gate

```
pnpm verify
```

Runs in order: `typecheck` → `lint:ci` → `test:cov` → `lint:comments`. All must pass before merging.

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
- Strip dead pointer tokens: `§N`, `§N Qn`, `plan NNNN`, bare plan numbers 0015–0018, `slice N`, `consensus MN`, `audit §X`.
- Do NOT strip `§N` when it appears alongside a valid in-repo doc path (e.g. `docs/specs/`).
- Fix punctuation minimally. Do NOT reword the explanation.

**Enforcement:** `pnpm run lint:comments` (wired into `pnpm verify`) scans `src/**/*.ts` (excluding `*.test.ts` and `src/e2e/**`) and exits 1 on any surviving banned token.
