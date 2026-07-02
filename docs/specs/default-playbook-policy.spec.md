# Default playbook policy spec

- **Status:** Accepted.
- **Version:** v1
- **Source files:** `control-plane/default-playbook/catalog/pipelines.json`,
  `src/control-plane/default-playbook-policy.ts`, `src/control-plane/default-playbook-policy.test.ts`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [human-gates-v1.spec.md](./human-gates-v1.spec.md).

The static bundled-playbook checks are accepted, and #141 merge-gate reject/recheck routing, #233 thread-recovery outcomes, #240 mergeability-honest `clean`, and #246 recovery/reverify graph reconciliation are implemented.

## Scope

This spec defines product policy for the bundled default `feature-development` playbook variants. It sits above the
generic pipeline grammar: `pipeline-core` validates whether a template is structurally legal; this policy validates
whether the bundled default graph keeps the handoffs and safeguards expected by the current Revo default pipeline.

The verifier covers two hand-authored PRODUCT catalog variants in
`control-plane/default-playbook/catalog/pipelines.json`:

- `feature-development` — the reconciled canonical variant; passes all rules with zero diagnostics.
- `feature-development-codex-consensus` — the pre-#242 variant; its current violations are documented in
  `CODEX_LEGACY_WAIVERS` (see Variant Handling). Profile/materializer/pinning rules are owned by #244/#245 and
  cross-referenced here, NOT duplicated.

The e2e test fixture at `src/e2e/fixtures/playbook/catalog/pipelines.json` is test infrastructure (a smaller
pre-escalation graph driven by specific e2e paths) and is out of product-policy scope. The AC's
"hand-authored variants" refers to the two product catalog entries above.

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
| #141 | `mergeGate` exposes `approved,recheck,address_review_threads,return_to_development,override_merge,cancel`; `recheck` routes through a fresh `mergeRecheck` `script:pollPr` node, then routes `review_changes` to `triage`, bounded `ci_changes + ciLoop < 3` to `ciRework`, and `clean`/default to `blockedEnd`; `address_review_threads` and `return_to_development` route to `triage`; `override_merge` routes to `mergeApproveReverify`; `cancel` routes to `cancelledEnd`; `triage` and `ciRework` receive optional stale-ok `mergeRecheck` evidence. | Actual GitHub/provider freshness, named-gate runtime execution, unresolved-thread detection, override audit persistence, and proof that live review/CI changes return to the correct recovery loop. |
| #246 | Recovery/reverify shape: recoverable script catches route to `classifyRecovery`; cap-router defaults reach a humanGate; `mergeGate` approved/override_merge routes through post-approval re-poll (`mergeApproveReverify`) before `confirmMerge`; `confirmMerge` consumes fresh `mergeApproveReverify` readiness; `confirmMerge -> cleanupWorktree -> mergedEnd` (no bypass); `confirmMerge` failure catches route to `classifyRecovery`; cancel/rework outcomes on all humanGates have explicit guarded branches; `failedEnd` removed. | Recovery/rework cycle correctness, post-approval freshness, worktree cleanup. |

## Static Rules

The bundled `feature-development` policy verifier reports errors for these statically checkable rules:

| Rule | Diagnostic code |
| --- | --- |
| The verifier is applied only to supported `feature-development` variants. | `DEFAULT_POLICY_WRONG_PIPELINE` |
| Developer/rework/CI/review-fix change producers expose `schema:change` outputs and downstream reviewer/integrator steps consume them. | `DEFAULT_POLICY_CHANGE_HANDOFF_MISSING` |
| PR readiness flows through `pollPr`, then a fresh `mergeReadiness` poll, then `mergeGate`; the gate surfaces the `mergeReadiness` artifact. | `DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING` |
| `mergeGate` approved and override_merge MUST route to `mergeApproveReverify` (a fresh `script:pollPr` re-poll); `mergeApproveReverifyRouter` clean MUST route to `confirmMerge`. | `DEFAULT_POLICY_APPROVE_REVERIFY_MISSING` |
| `confirmMerge` MUST consume `mergeApproveReverify` as `mergeReadiness` (not the pre-gate stale `mergeReadiness` node). | `DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING` |
| Merge-gate `recheck` routes to a fresh `mergeRecheck` `script:pollPr`, `cancel` routes to `cancelledEnd`, then the recheck router preserves recoverable `review_changes`/bounded `ci_changes` routes and explicit `clean`/default aborts. `mergeRecheckRouter` default MUST route to `recoveryGate`. | `DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING` |
| `review_changes` routes to triage, triage can ask a question, choose `fix`, or choose `wontfix`, and `fix` flows through developer rework before thread responses. | `DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING` |
| `ci_changes` routes from both PR routers to `ciRework` while `ciLoop < 3`, and `ciRework` returns to `integrator`. | `DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING` |
| `blockedEnd` remains a first-class `blocked` terminal. | `DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING` |
| `cancelledEnd` remains a first-class `cancelled` terminal. | `DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING` |
| Plan-review and code-review loop exhaustion route to reusable human gates with `rework` and `cancel`; code-stuck rework resets the normal code-review loop through scope parentage instead of using `codeFinalStuckGate`. | `DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING` |
| Script catches on recoverable nodes (`pollPr`, `mergeReadiness`, `mergeRecheck`, `mergeApproveReverify`, `integrator`, `reviewIntegrator`, `respondThreads`) MUST NOT route to a terminal node. | `DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL` |
| The default branch of every cap-bounded router (`prRouter`, `mergeReadinessRouter`, `mergeRecheckRouter`, `triageRouter`, `recoveryRouter`, `planReviewRouter`, `codeReviewRouter`) MUST resolve to a `humanGate` or `classifyRecovery`, never a terminal. | `DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING` |
| `confirmMerge` script catches (`revo.ScriptBlocked`, `revo.ScriptFailed`) MUST NOT route to a terminal node; base-drift and head-guard failures are recoverable. | `DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL` |
| `confirmMerge.next` MUST be `cleanupWorktree`; `cleanupWorktree` MUST be a `script:cleanupWorktree` node with `.next = mergedEnd`. No `confirmMerge -> mergedEnd` bypass is permitted. | `DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING` |
| Every `humanGate` that declares a `cancel` or `rework` outcome MUST have a guarded (non-default) branch whose condition explicitly mentions that verdict. `approved`, `recheck`, and other outcomes MAY fall to the `default` branch. | `DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT` |
| The codex variant's actual violation set MUST be a subset of `CODEX_LEGACY_WAIVERS` (every fired code must be consciously documented). | `DEFAULT_POLICY_VARIANT_POLICY_GAP` |
| The codex variant's actual violation set MUST exactly match `CODEX_LEGACY_WAIVERS` (drift in either direction signals an undocumented graph change). | `DEFAULT_POLICY_VARIANT_PARITY_DRIFT` |

## Variant Handling

The verifier dispatches to the same reconciled rule set for both supported variants. The canonical `feature-development`
passes with zero diagnostics. `feature-development-codex-consensus` is the pre-#242 old-shaped variant and emits a
documented set of violations.

`CODEX_LEGACY_WAIVERS` (in `default-playbook-policy.ts`) is derived empirically — by running the reconciled rule set
over codex — and frozen as the #242 debt snapshot. When #242 reconciles the codex graph, the actual violation set
shrinks and `VARIANT_PARITY_DRIFT` fires, prompting removal of entries. Once codex is fully reconciled, `CODEX_LEGACY_WAIVERS`
empties and `feature-development-codex-consensus` joins the canonical as a zero-diagnostic variant.

To update `CODEX_LEGACY_WAIVERS`: run `validateDefaultPlaybookPolicy(codexTemplate)`, capture the unique code set,
replace the constant, and commit with a reference to the issue that changed the graph.

Cross-references:
- #242 — reconciles the codex graph; empties `CODEX_LEGACY_WAIVERS`.
- #244 — typed profile bindings; owns `PROFILE_*` codes (not duplicated here).
- #245 — topology materializer and materialized-variant rules; adds materialized variants to coverage after landing.
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
The router MUST send a still-clean recheck, or an unclassified/default recheck, to `blockedEnd` as an explicit
abort. The router MUST send recoverable fresh feedback back into the existing loops: `review_changes -> triage` and
`ci_changes + ciLoop < 3 -> ciRework`. The router default MUST reach `recoveryGate`.

The verifier also requires both `triage` and `ciRework` to consume `mergeRecheck` as optional stale-ok
`recheckFeedback`, so recheck-routed recovery steps can inspect the fresh recheck evidence. This remains a static graph
contract: the verifier does not prove that GitHub/provider state was fresh at runtime.

## Changelog

- 2026-07-02: Generalized verifier to cover `feature-development` + `feature-development-codex-consensus`; added 9
  new static rules (RECOVERABLE_CATCH_TERMINAL, CAP_EXHAUSTION_OFFRAMP_MISSING, APPROVE_REVERIFY_MISSING,
  MERGE_READINESS_FRESHNESS_MISSING, CONFIRM_MERGE_FAILURE_TERMINAL, POST_MERGE_CLEANUP_MISSING,
  GATE_OUTCOMES_IMPLICIT, VARIANT_POLICY_GAP, VARIANT_PARITY_DRIFT); migrated reverify/fresh-readiness checks from
  PR_FRESHNESS to first-class codes; added CODEX_LEGACY_WAIVERS + validateVariantParity; updated Scope and Variant
  Handling subsection (issue #247).
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
