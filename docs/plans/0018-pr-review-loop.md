# Plan 0018 — PR review-feedback loop (observe CI + reviews → triage → fix → reply/resolve)

**Status:** in progress.

## Goal

After the integrator opens the (draft) PR, **observe** it until CI settles, then route feedback by TYPE:
- **CI / Sonar failures** (automated) → the **developer** fixes them directly.
- **Review comments** (CodeRabbit / human reviewers) → the **analyst** triages (decides *whether* and *how*
  to fix, seeing the actual diff), the developer implements, and we **reply in each thread + resolve it**.
- Genuinely ambiguous comments → a **human question gate**.
- All green + threads resolved → the existing merge gate → `confirmMerge`.

This extends the existing watcher loop (`watcherPost`/`watcherRouter`/`watcherRework`, bounded) and reuses
the existing PR-readiness poller (`src/poller/pr-readiness.ts`) + the 0016 dataflow (`produces`/`consumes`,
`run_outputs`). No new durable table — per-run `run_outputs` carries the thread map; resolved threads drop
off GitHub naturally so the loop converges.

## Pipeline tail (data-driven template)

```text
integrator (draft PR)
  → pollPr (script) ── clean ───────────────→ mergeGate → confirmMerge → merged
                    ── ci_changes  (cap) ────→ ciRework (developer, consumes prFeedback.ci) → integrator → pollPr
                    ── review_changes (cap) ─→ triage (analyst)
                    ── timeout / cap ────────→ blockedEnd (human)
  triage (analyst) ── has question ─────────→ questionGate (human answer_question) → triage
                   ── fix items ────────────→ reviewRework (developer, consumes triage) → respondThreads → integrator → pollPr
                   ── only wontfix ─────────→ respondThreads (reply + resolve)         → pollPr
```

Separate counters `ciLoop` / `reviewLoop` bound each path independently.

## Nodes

### `pollPr` (script:pollPr) — observe + classify (deterministic, no LLM)
- Polls CI until terminal or a timeout (reuse `pr-readiness`).
- Collects, via `gh api graphql` on `repository.pullRequest.reviewThreads`:
  `{ threadId(id), isResolved, path, line, comments{author.login, body} }` — only UNRESOLVED threads.
- Collects CI failures via `statusCheckRollup` (name, conclusion, detailsUrl).
- `produces: prFeedback = { prNumber, headSha, ciFailures[], reviewThreads[] }`.
- Verdict (decision order): unresolved `reviewThreads` non-empty → **review_changes**; else `ciFailures`
  non-empty → **ci_changes**; else **clean**. Poll timeout with checks still pending → block (human).

### `triage` (agent, role:analyst) — sees the real diff
- Runs in the run's **worktree** (the branch with the changes) → reads `git diff origin/<base>` + files.
- `consumes: { plan: analyst, feedback: pollPr }`. Per unresolved thread decides:
  `fix` | `wontfix` | `question`, with `guidance` (for the dev) and `replyText` (to post).
- `produces: triage = { items: [{threadId, decision, guidance, replyText}], ciGuidance, needsHuman }`.
- Verdict: `question` if any item is a question; else `fix` if any fix; else `wontfix`.

### `questionGate` (humanGate, separate from mergeGate)
- Fires when triage has `question` items; surfaces the question(s) via the inbox `question` kind
  (`answer_question` tool). The answer feeds back into `triage` (re-run with the human's answer).

### `ciRework` / `reviewRework` (agent, role:developer)
- `ciRework` consumes `prFeedback.ciFailures` (+ analyst CI guidance) → fixes in the worktree.
- `reviewRework` consumes `triage` (the `fix` items' guidance) → implements in the worktree.
- Both → `integrator` re-pushes to the SAME PR branch.

### `respondThreads` (script:respondThreads) — reply + resolve
- Runs immediately AFTER the push (carries the fix sha). `consumes: triage`.
- For each triaged thread (decision fix OR wontfix — "what we touched + what we decided"):
  `gh api graphql addPullRequestReviewThreadReply` (body = `replyText`; for fix: include the new sha) then
  `resolveReviewThread(threadId)`. Reply+resolve ONLY the threads we acted on (not arbitrary threads).
- wontfix auto-resolves with the analyst's reason; if a reviewer later reopens/adds a comment, the next
  `pollPr` catches it.

## Decisions (agreed 2026-06-18)
1. **wontfix → auto-resolve** with the reason; a reopened/new comment is caught on the next `pollPr`.
2. **Resolve the threads we touched** — both the `fix` and `wontfix` decisions; not arbitrary threads.
3. **Reply immediately after push** (so the reply carries the fix sha).
4. **Separate `questionGate`** (per-thread questions), distinct from the final `mergeGate`.
5. **Build the whole graph at once, with e2e** (not sliced).

## State
- Thread ids + bodies + per-thread decisions ride the **0016 `run_outputs`** accumulator (`pollPr` produces,
  `triage`/`respondThreads`/rework consume). No new table. Across loop iterations the accumulator persists;
  resolved threads disappear from GitHub so the loop converges. (A cross-run audit table is a later option.)

## gh mechanics (live) — verified field names on real gh (plan 0017 lesson)
- Threads: `gh api graphql -f query='… reviewThreads(first:n){nodes{id isResolved path line comments(first:1){nodes{author{login} body}}}} …'`.
- Reply: `addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId, body})`.
- Resolve: `resolveReviewThread(input:{threadId})`.
- All via the gh-pinned `execGh` (account revisium-io), like the integrator.

## Tests
- Unit: `pollPr` classify (review>ci>clean, timeout), `triage` verdict mapping, `respondThreads`
  reply+resolve per decision; the gh-graphql helpers.
- e2e: extend the gh emulator with `reviewThreads` (stateful: resolve removes them) + the graphql
  reply/resolve mutations. Scenarios: CI-red → dev fixes → green → merge; review-comment → analyst triage →
  dev fix → reply+resolve → green → merge; wontfix → reply+resolve → merge; question → questionGate.

## Follow-ups (deferred)
- Cross-run `pr_threads` audit table; analyst-driven full re-plan (plan gate) for design-level comments;
  plan 0017 `cleanup_worktree` tool + orphan sweep (#16).
