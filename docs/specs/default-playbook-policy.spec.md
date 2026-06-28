# Default playbook policy spec

- **Status:** Accepted for static bundled-playbook checks; #141 merge-gate reject/recheck routing is implemented.
- **Source files:** `control-plane/default-playbook/catalog/pipelines.json`,
  `src/control-plane/default-playbook-policy.ts`, `src/control-plane/default-playbook-policy.test.ts`.
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [human-gates-v1.spec.md](./human-gates-v1.spec.md).

## Scope

This spec defines product policy for the bundled default `feature-development` playbook. It sits above the generic
pipeline grammar: `pipeline-core` validates whether a template is structurally legal; this policy validates whether
the bundled default graph keeps the handoffs and safeguards expected by the current Revo default pipeline.

The policy verifier is deterministic and I/O-free. It must not call GitHub, runner providers, network services,
Revisium, DBOS, or the filesystem. Runtime facts such as provider freshness, branch contents, pushed commits, actual
review-thread state, and artifact payload content are verified by runtime tests and PR watcher evidence, not by this
static verifier.

## Stabilization Map

| Issue | Static default-playbook policy | Runtime evidence check | Deferred |
| --- | --- | --- | --- |
| #140 | Change-producing developer nodes declare `schema:change` outputs, and reviewer/integrator nodes consume those produced changes. | Captured `branch`/`headSha`, worktree cleanliness, actual pushed PR head, and integrator behavior. | No |
| #142 | The graph preserves routes that can carry `review_changes` and `ci_changes` after `pollPr` classifies PR feedback. | CodeRabbit/provider classification, stale review-body suppression, provider-wait bucketing, and grace polling. | No |
| #143 | The graph requires `pollPr -> mergeReadiness -> mergeGate`, routes fresh `review_changes`/`ci_changes` before the gate, and gives merge approval/confirmation the `mergeReadiness` artifact. | Isolated worktree execution, real PR polling, fresh `headSha`, branch push, and provider state. | No |
| #144 | No graph policy is inferred from stale provider comments or install versioning; the default catalog can still be checked statically. | `catalogHash` reseed behavior and informational provider waits for stale CodeRabbit comments. | No |
| #141 | `mergeGate` reject/non-approve maps to `recheck`, routes through a fresh `mergeRecheck` `script:pollPr` node, then routes `review_changes` to `triage`, bounded `ci_changes + ciLoop < 3` to `ciRework`, and `clean`/default to `blockedEnd`; `triage` and `ciRework` receive optional stale-ok `mergeRecheck` evidence. | Actual GitHub/provider freshness, rejected-gate runtime execution, and proof that live review/CI changes return to the correct recovery loop. | No |

## Static Rules

The bundled `feature-development` policy verifier reports errors for these statically checkable rules:

| Rule | Diagnostic code |
| --- | --- |
| The verifier is applied only to `feature-development`. | `DEFAULT_POLICY_WRONG_PIPELINE` |
| Developer/rework/CI/review-fix change producers expose `schema:change` outputs and downstream reviewer/integrator steps consume them. | `DEFAULT_POLICY_CHANGE_HANDOFF_MISSING` |
| PR readiness flows through `pollPr`, then a fresh `mergeReadiness` poll, then `mergeGate`; the gate and `confirmMerge` use the `mergeReadiness` output. | `DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING` |
| Merge-gate reject/non-approve routes to a fresh `mergeRecheck` `script:pollPr`, then the recheck router preserves recoverable `review_changes`/bounded `ci_changes` routes and explicit `clean`/default aborts. | `DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING` |
| `review_changes` routes to triage, triage can ask a question, choose `fix`, or choose `wontfix`, and `fix` flows through developer rework before thread responses. | `DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING` |
| `ci_changes` routes from both PR routers to `ciRework` while `ciLoop < 3`, and `ciRework` returns to `integrator`. | `DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING` |
| `blockedEnd` remains a first-class `blocked` terminal. | `DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING` |
| Plan-review and code-review loop exhaustion route to human gates instead of dead-ending directly at `blockedEnd`. | `DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING` |

## Implemented #141 Rule

The scoped policy requires the bundled `mergeGate` to expose `approved,recheck` outcomes. Because the runtime maps a
gate approval to the first outcome and rejection to the last outcome, a merge-gate reject reaches `mergeRecheck`
instead of terminal-blocking immediately.

`mergeRecheck` must be a `script:pollPr` step that produces `schema:prFeedback` and routes to
`mergeRecheckRouter`. The router must send a still-clean recheck, or an unclassified/default recheck, to
`blockedEnd` as an explicit abort. It must send recoverable fresh feedback back into the existing loops:
`review_changes -> triage` and `ci_changes + ciLoop < 3 -> ciRework`.

The verifier also requires both `triage` and `ciRework` to consume `mergeRecheck` as optional stale-ok
`recheckFeedback`, so reject-routed recovery steps can inspect the fresh recheck evidence. This remains a static graph
contract: the verifier does not prove that GitHub/provider state was fresh at runtime.

## Changelog

- 2026-06-28: Updated #141 from deferred to implemented in the default policy, including merge-gate recheck routing
  and recheck evidence handoff checks.
- 2026-06-28: Added scoped default-playbook policy for #145 with static rules separated from runtime evidence checks
  and #141 explicitly deferred.
