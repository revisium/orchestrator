# Default playbook policy spec

- **Status:** Accepted
- **Version:** v1
- **Source files:** `control-plane/default-playbook/catalog/pipelines.json`,
  `src/control-plane/default-playbook-policy.ts`, `src/control-plane/default-playbook-policy.test.ts`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [human-gates-v1.spec.md](./human-gates-v1.spec.md),
  [execution-plan-v1.spec.md](./execution-plan-v1.spec.md),
  [resources-workspaces-effects-v1.spec.md](./resources-workspaces-effects-v1.spec.md),
  [script-runtime-v1.spec.md](./script-runtime-v1.spec.md).

The static bundled-playbook checks are accepted, and #141 merge-gate reject/recheck routing, #233 thread-recovery outcomes, #240 mergeability-honest `clean`, and #246 recovery/reverify graph reconciliation are implemented.

## Scope

This spec defines product policy for the bundled default `feature-development` playbook. It sits above the
generic pipeline grammar: `pipeline-core` validates whether a template is structurally legal; this policy validates
whether the bundled default graph keeps the handoffs and safeguards expected by the current Revo default pipeline.

The verifier covers the canonical PRODUCT catalog pipeline in
`control-plane/default-playbook/catalog/pipelines.json`:

- `feature-development` — the reconciled canonical variant; passes all rules with zero diagnostics.

The e2e test fixture at `src/e2e/support/fixtures/playbook/catalog/pipelines.json` is test infrastructure (a smaller
pre-escalation graph driven by specific e2e paths) and is out of product-policy scope. The AC's
"hand-authored variants" refers to product catalog entries, not run profiles.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

The policy verifier is deterministic and I/O-free. It MUST NOT call GitHub, runner providers, network services,
Revisium, DBOS, or the filesystem. Runtime facts such as provider freshness, branch contents, pushed commits, actual
review-thread state, and artifact payload content are verified by runtime tests and PR watcher evidence, not by this
static verifier.

## Stabilization Map

| Issue | Static default-playbook policy | Runtime evidence check |
| --- | --- | --- |
| #140 | Change-producing developer nodes declare `schema:change` outputs, and reviewer/integrator nodes consume those produced changes. | Captured `branch`/`headSha`, worktree cleanliness, actual pushed PR head, and integrator behavior. |
| #142 | The graph preserves routes that can carry `review_changes` and `ci_changes` after `pollPr` classifies PR feedback. | CodeRabbit/provider classification, stale review-body suppression, provider-wait bucketing, and grace polling. |
| #143 | The graph requires `pollPr -> mergeReadiness -> mergeGate`, routes fresh `review_changes`/`ci_changes` before the gate, and gives merge approval/confirmation the `mergeReadiness` artifact. | Isolated worktree execution, real PR polling, fresh `headSha`, branch push, and provider state. |
| #144 | No graph policy is inferred from stale provider comments or install versioning; the default catalog can still be checked statically. | `catalogHash` reseed behavior and informational provider waits for stale CodeRabbit comments. |
| #141/#276 | `mergeGate` exposes `approved,recheck,address_review_threads,return_to_development,override_merge,cancel`; `recheck` routes through a fresh `mergeRecheck` `script:pollPr` node, then routes `clean` back to `mergeGate`, `review_changes` to `triage`, bounded `ci_changes + ciLoop < 3` to `ciRework`, `recheck` to `mergeReadiness`, and default to `recoveryGate`; `address_review_threads` and `return_to_development` route to `triage`; `override_merge` routes to `mergeApproveReverify`; `cancel` routes to `cancelledEnd`; `triage` and `ciRework` receive optional stale-ok `mergeRecheck` evidence. | Actual GitHub/provider freshness, named-gate runtime execution, unresolved-thread detection, override audit persistence, and proof that live review/CI changes return to the correct recovery loop. |
| #246 | Recovery/reverify shape: recoverable script catches route to `classifyRecovery`; cap-router defaults reach a humanGate; `mergeGate` approved/override_merge routes through post-approval re-poll (`mergeApproveReverify`) before `confirmMerge`; `confirmMerge` consumes fresh `mergeApproveReverify` readiness; `confirmMerge -> cleanupWorktree -> mergedEnd` (no bypass); `confirmMerge` failure catches route to `classifyRecovery`; cancel/rework outcomes on all humanGates have explicit guarded branches; `failedEnd` removed. | Recovery/rework cycle correctness, post-approval freshness, worktree cleanup. |
| #272 | `pollPr` and `mergeReadiness` increment a shared `pollLoop` scope; their `recheck` self-loop branches are guarded by `pollLoop < 8`; cap exhaustion routes through the router default off-ramp instead of relying on engine `MAX_STEPS`. | Zero-CI first-poll readiness, unclassifiable provider state classification, and never-settling PRs reaching a human gate. |
| #273 | Every `script:pollPr` router treats terminal PR states explicitly: `merged -> cleanupWorktree` and `closed -> recoveryGate`. Terminal states do not fall through to CI/review readiness loops or confirm-merge. | Branch lookup over open + all PR states; externally merged PR cleanup without `gh pr merge`; externally closed PR gate evidence includes `pr_closed_externally`. |

## Static Rules

The bundled `feature-development` policy verifier reports errors for these statically checkable rules:

| Rule | Diagnostic code |
| --- | --- |
| The verifier is applied only to supported `feature-development` templates. | `DEFAULT_POLICY_WRONG_PIPELINE` |
| Developer/rework/CI/review-fix change producers expose `schema:change` outputs and downstream reviewer/integrator steps consume them. | `DEFAULT_POLICY_CHANGE_HANDOFF_MISSING` |
| PR readiness flows through `pollPr`, then a fresh `mergeReadiness` poll, then `mergeGate`; terminal `merged` routes cleanup and terminal `closed` routes recovery; the gate surfaces the `mergeReadiness` artifact. | `DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING` |
| `pollPr` and `mergeReadiness` recheck branches MUST be bounded by `pollLoop < 8`, and `pollLoop` MUST be declared with `cap=8`. | `DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING` |
| `mergeGate` approved and override_merge MUST route to `mergeApproveReverify` (a fresh `script:pollPr` re-poll); `mergeApproveReverifyRouter` clean MUST route to `confirmMerge`, `merged` to `cleanupWorktree`, and `closed` to `recoveryGate`. | `DEFAULT_POLICY_APPROVE_REVERIFY_MISSING` |
| `confirmMerge` MUST consume `mergeApproveReverify` as `mergeReadiness` (not the pre-gate stale `mergeReadiness` node). | `DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING` |
| Merge-gate `recheck` routes to a fresh `mergeRecheck` `script:pollPr`, `cancel` routes to `cancelledEnd`, then the recheck router sends `clean` back to `mergeGate`, `merged` to `cleanupWorktree`, `closed` to `recoveryGate`, preserves recoverable `review_changes`/bounded `ci_changes` routes, and routes default to `recoveryGate`. | `DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING` |
| `review_changes` routes to triage, triage can ask a question, choose `fix`, or choose `wontfix`; direct triage `fix` flows through `reviewRework`, while `questionGate fix` flows through `questionReviewRework` with the gate resolution before thread responses. | `DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING` |
| `ci_changes` routes from both PR routers to `ciRework` while `ciLoop < 3`, and `ciRework` returns to `integrator`. | `DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING` |
| `blockedEnd` remains a first-class `blocked` terminal. | `DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING` |
| `cancelledEnd` remains a first-class `cancelled` terminal. | `DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING` |
| Plan-review and code-review loop exhaustion route to reusable human gates with `rework` and `cancel`; code-stuck rework resets the normal code-review loop through scope parentage instead of using `codeFinalStuckGate`. | `DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING` |
| Script catches on recoverable nodes (`pollPr`, `mergeReadiness`, `mergeRecheck`, `mergeApproveReverify`, `integrator`, `reviewIntegrator`, `questionReviewIntegrator`, `respondThreads`) MUST NOT route to a terminal node. | `DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL` |
| The default branch of every cap-bounded router (`prRouter`, `mergeReadinessRouter`, `mergeRecheckRouter`, `triageRouter`, `recoveryRouter`, `planReviewRouter`, `codeReviewRouter`) MUST resolve to a `humanGate` or `classifyRecovery`, never a terminal. | `DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING` |
| `confirmMerge` script catches (`revo.ScriptBlocked`, `revo.ScriptFailed`) MUST NOT route to a terminal node; base-drift and head-guard failures are recoverable. | `DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL` |
| `confirmMerge.next` MUST be `cleanupWorktree`; `cleanupWorktree` MUST be a `script:cleanupWorktree` node with `.next = mergedEnd`. No `confirmMerge -> mergedEnd` bypass is permitted. | `DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING` |
| Every declared `humanGate` outcome MUST have a guarded (non-default) branch whose condition explicitly mentions that verdict. Defaults catch only out-of-menu or invalid verdicts. | `DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT` |

`pollPr` and `confirmMerge` both may mark a draft PR ready for review. `gh pr ready` failures MUST NOT be swallowed:
non-benign failures are surfaced as redacted recovery evidence and route through the existing recovery gate with
`recheck,cancel`. A benign GitHub response that the PR is already ready/not draft is idempotent success.

## Target GitHub-first policy V2

Everything above this section is the shipped, implemented V1 policy. ADR-0010/0011 require one atomic target switch;
the target MUST NOT be described as landed until the catalog, verifier, workflow adapter, and runtime tests all move
together.

The V2 bundled `feature-development` proof remains:

```text
task -> approved plan -> implementation -> reviewed pull request -> merge approval -> merge
```

The target changes ownership, not product safety outcomes:

- the pipeline declares one named repository resource and a mutable isolated workspace policy;
- every agent/script node declares resource access and captures;
- implementation steps produce `workspaceChange` and `gitChange`, not `schema:change`;
- Git commit, push, pull-request upsert, mark-ready, readiness snapshot, thread response/resolution, and merge use the
  explicit `script:git/*` and `script:github/*` definitions from script-runtime-v1;
- readiness is one mutation-free snapshot; bounded `choice`/`wait` loops own waiting and escalation, and every
  bundled readiness recheck uses exact `PT30S` through the DBOS-backed adapter timer;
- plan and merge approval consume provider-neutral subjects for exact revisions;
- approved and override routes capture a fresh readiness snapshot before merge and require matching
  subject/readiness revisions;
- externally merged pull requests reach the merged terminal and lifecycle releases the workspace without a graph
  cleanup node;
- externally closed unmerged pull requests reach human recovery with `pr_closed_externally` evidence;
- cancellation and configured terminal paths invoke lifecycle release outside graph topology;
- script failures preserve existing recovery outcomes without executor branches on node ids;
- account aliases are resource credential pins, not named-node expansion.

The `PT30S` rule applies to the product catalog. The E2E fixture catalog uses exact `PT0.050S` with the topology
parity proof owned by pipeline-test-coverage-v1; the product verifier does not accept it as production policy.

Target static-policy families:

| Rule | Target diagnostic |
| --- | --- |
| Required repository resource, mutable isolated workspace, and complete node access/capture declarations exist. | `DEFAULT_POLICY_RESOURCE_PLAN_MISSING` |
| Every V2 script node declares complete `inputBindings` from dominating typed outputs or approved plan fields, and the resolved shape matches its pinned input schema. | `DEFAULT_POLICY_SCRIPT_INPUT_BINDING_INVALID` |
| Change producers and consumers use split typed artifacts. | `DEFAULT_POLICY_TYPED_CHANGE_HANDOFF_MISSING` |
| Readiness is followed by bounded choice/wait routing, recheck waits are exactly `PT30S`, and observation owns no mutation. | `DEFAULT_POLICY_READINESS_LOOP_INVALID` |
| Mark-ready, thread writes, and merge are separate registered operations. | `DEFAULT_POLICY_GITHUB_EFFECT_SPLIT_MISSING` |
| Plan and merge approvals consume provider-neutral subjects at exact revisions. | `DEFAULT_POLICY_APPROVAL_SUBJECT_MISSING` |
| Merge subject and post-approval readiness refer to the same head revision. | `DEFAULT_POLICY_APPROVAL_REVISION_FENCE_MISSING` |
| Merge script catches MUST NOT route to a terminal node; base-drift and head-guard failures remain recoverable. | `DEFAULT_POLICY_MERGE_FAILURE_TERMINAL` |
| No `script:cleanupWorktree` or old script ref remains. | `DEFAULT_POLICY_LEGACY_EFFECT_PRESENT` |
| No lifecycle path depends on a graph edge after merge/cancel/failure. | `DEFAULT_POLICY_LIFECYCLE_OWNERSHIP_INVALID` |

Every shipped safeguard family has an explicit V2 fate:

| Shipped V1 diagnostic | V2 requirement / diagnostic |
| --- | --- |
| `DEFAULT_POLICY_WRONG_PIPELINE` | Preserved for V2 `feature-development`. |
| `DEFAULT_POLICY_CHANGE_HANDOFF_MISSING` | Replaced atomically by `DEFAULT_POLICY_TYPED_CHANGE_HANDOFF_MISSING`. |
| `DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING` | Re-expressed by readiness routing, terminal routing, and `DEFAULT_POLICY_APPROVAL_REVISION_FENCE_MISSING`. |
| `DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING` | Preserved over explicit counters for readiness, plan review, and code review. |
| `DEFAULT_POLICY_APPROVE_REVERIFY_MISSING` | Preserved by `DEFAULT_POLICY_APPROVAL_REVISION_FENCE_MISSING`; approved and override routes take a fresh snapshot. |
| `DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING` | Preserved by the same revision fence; merge consumes only the post-approval snapshot. |
| `DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING` | Preserved over V2 operation refs and typed outputs. |
| `DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING` | Preserved over V2 readiness verdicts and typed evidence. |
| `DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING` | Preserved, including bounded `ciLoop`. |
| `DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING` | Preserved; lifecycle applies `onBlocked` after terminal recording. |
| `DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING` | Preserved; lifecycle applies `onCancel` outside graph topology. |
| `DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL` | Preserved for every readiness and Git/GitHub mutation node. |
| `DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING` | Preserved; exhaustion reaches a question/recovery gate. |
| `DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL` | Re-expressed as `DEFAULT_POLICY_MERGE_FAILURE_TERMINAL`. |
| `DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING` | Retired only as graph shape and replaced by `DEFAULT_POLICY_LIFECYCLE_OWNERSHIP_INVALID`. |
| `DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT` | Preserved for every V2 human gate and named outcome. |

V2 additionally reports `DEFAULT_POLICY_PR_TERMINAL_ROUTE_MISSING` unless externally merged routes to the merged
terminal and externally closed-unmerged routes to recovery. It reports `DEFAULT_POLICY_ZERO_CI_READINESS_ROUTE_MISSING`
unless a mergeable PR with no registered checks may classify `clean` on the first snapshot.

Definite-negative mergeability is an intentional named parity replacement: V1 `DIRTY`, `BLOCKED`, `BEHIND`, or
`CONFLICTING` terminated at `blockedEnd`; V2 records `unclassifiable` and routes through `classifyRecovery` to a human
`recoveryGate` with no merge edge. The parity golden MUST name and test this replacement rather than claim the old
terminal route is preserved.

V2 replaces V1 in one catalog/policy version. Mixed old/new script refs or both `schema:change` and split artifacts
are invalid. There are no aliases, dual paths, historical-run migrations, or fallback behaviors.

A parity golden enumerates every V1 diagnostic and requires its named V2 successor or the single explicit cleanup
graph-shape retirement. It also proves bounded review/CI recovery, zero-CI readiness, externally merged/closed routing,
explicit gate outcomes, and post-approval freshness. Production cutover cannot land while any entry is unmapped.

## Profile-Materialized Templates

The verifier can also be applied to materialized templates produced from stored run profile data. A seeded consensus
profile is read from `control-plane/default-playbook/catalog/run-profiles.json`, converted through
`src/control-plane/run-profiles.ts`, materialized with `materializeTemplate`, and then checked with the same
`validateDefaultPlaybookPolicy` rule set.

Run profiles are not product pipeline variants. Their import/versioning rules are owned by
[run-profiles-v1.spec.md](./run-profiles-v1.spec.md); this policy spec only states that a materialized default
feature-development template must preserve the same static safeguards.

Cross-references:
- #244 — typed profile bindings; owns `PROFILE_*` codes (not duplicated here).
- #245 — topology materializer and materialized-variant rules.
- #248 — runtime/replay/e2e matrix for policy rules.

The `PR_FRESHNESS_WIRING_MISSING` code remains for the `pollPr -> mergeReadiness -> mergeGate` path. The post-approval
reverify and fresh-readiness-consumption checks are now first-class codes (`APPROVE_REVERIFY_MISSING` and
`MERGE_READINESS_FRESHNESS_MISSING`), not folded under `PR_FRESHNESS_WIRING_MISSING`.

## Implemented #141 Rule

The scoped policy requires the bundled `mergeGate` to expose
`approved,recheck,address_review_threads,return_to_development,override_merge,cancel` outcomes. The runtime accepts
explicit named gate outcomes through `resolve_gate` / `resolveGate`; compatibility wrappers are not used for
multi-outcome gates. `recheck` reaches `mergeRecheck`; `address_review_threads` and `return_to_development` both
reach `triage`; `override_merge` and `approved` both reach `mergeApproveReverify` (post-approval re-poll); and
`cancel` reaches the `cancelledEnd` terminal.

`mergeRecheck` MUST be a `script:pollPr` step that produces `schema:prFeedback` and routes to `mergeRecheckRouter`.
The router MUST send a still-clean recheck back to `mergeGate`, preserving the human-driven recheck loop. The router
MUST send recoverable fresh feedback back into the existing loops: `review_changes -> triage` and
`ci_changes + ciLoop < 3 -> ciRework`; `recheck -> mergeReadiness`; and default -> `recoveryGate`.

The verifier also requires both `triage` and `ciRework` to consume `mergeRecheck` as optional stale-ok
`recheckFeedback`, so recheck-routed recovery steps can inspect the fresh recheck evidence. This remains a static graph
contract: the verifier does not prove that GitHub/provider state was fresh at runtime.

## Changelog

- 2026-07-12: Fixed V2 readiness waits at `PT30S` and required the durable adapter timer.
- 2026-07-12: Added the Draft V2 atomic-cutover policy with named resources, typed artifacts, explicit operations,
  provider-neutral approval subjects, and lifecycle-owned release.
- 2026-07-11: Normalized Status metadata to the exact enum value; no contract change.
- 2026-07-06: #273 — `script:pollPr` terminal verdicts now leave readiness loops explicitly:
  externally merged PRs route through `cleanupWorktree -> mergedEnd`, while externally closed unmerged PRs route to
  `recoveryGate` with `pr_closed_externally` evidence.
- 2026-07-06: #276 — removed dead-end gate outcomes: `mergeRecheckRouter.clean` re-presents `mergeGate`,
  `recoveryGate` exposes only `recheck,cancel`, `questionGate` exposes `fix,wontfix,cancel`, and
  `GATE_OUTCOME_UNROUTED` is enforced as an error. `questionGate fix` now routes through
  `questionReviewRework`, which receives the gate resolution before integration and thread responses.
- 2026-07-06: #272 — bounded `pollPr`/`mergeReadiness` readiness recheck self-loops with `pollLoop < 8`,
  documented cap exhaustion as a recovery off-ramp, and made counterless resilience cycles errors.
- 2026-07-07: Run profiles are catalog-backed control-plane data; provider/topology choices are no longer public
  pipeline variants or TypeScript registry entries.
- 2026-07-02: Generalized verifier for materialized feature-development templates; added 7
  new static rules (RECOVERABLE_CATCH_TERMINAL, CAP_EXHAUSTION_OFFRAMP_MISSING, APPROVE_REVERIFY_MISSING,
  MERGE_READINESS_FRESHNESS_MISSING, CONFIRM_MERGE_FAILURE_TERMINAL, POST_MERGE_CLEANUP_MISSING,
  GATE_OUTCOMES_IMPLICIT); migrated reverify/fresh-readiness checks from PR_FRESHNESS to first-class codes.
- 2026-07-02: `pollPr`/`mergeReadiness` `clean` now requires mergeability clean in addition to required
  checks and no unresolved threads; `UNKNOWN`/async → `recheck`; definite-negative merge state → `blockedEnd`
  reason `poll-pr` (issue #240).
- 2026-07-01: Added thread-recovery outcomes (`address_review_threads`, `return_to_development`, `override_merge`) to
  mergeGate domain and #141 stabilization row; updated "Implemented #141 Rule" accordingly (issue #233).
- 2026-07-01: Added cancelled terminal and reusable ordinary stuck-review gate policy.
- 2026-06-29: Normative-language / canon-discipline pass; no contract change.
- 2026-06-30: Added named gate outcome and readiness `recheck` routing notes for #223.
- 2026-06-28: Updated #141 from deferred to implemented in the default policy, including merge-gate recheck routing
  and recheck evidence handoff checks.
- 2026-06-28: Added scoped default-playbook policy for #145 with static rules separated from runtime evidence checks
  and #141 explicitly deferred.
