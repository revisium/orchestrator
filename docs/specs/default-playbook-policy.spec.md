# Default playbook policy spec

- **Status:** Accepted for static bundled-playbook checks; #141 merge-gate rejection reroute remains deferred.
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
| #141 | Current `mergeGate` rejection/default routing to `blockedEnd` is allowed. The verifier must not claim final stale merge-gate rejection behavior is implemented. | Final stale merge-gate rejection reroute and proof that rejected stale approvals return to rework/triage. | Yes |

## Static Rules

The bundled `feature-development` policy verifier reports errors for these statically checkable rules:

| Rule | Diagnostic code |
| --- | --- |
| The verifier is applied only to `feature-development`. | `DEFAULT_POLICY_WRONG_PIPELINE` |
| Developer/rework/CI/review-fix change producers expose `schema:change` outputs and downstream reviewer/integrator steps consume them. | `DEFAULT_POLICY_CHANGE_HANDOFF_MISSING` |
| PR readiness flows through `pollPr`, then a fresh `mergeReadiness` poll, then `mergeGate`; the gate and `confirmMerge` use the `mergeReadiness` output. | `DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING` |
| `review_changes` routes to triage, triage can ask a question, choose `fix`, or choose `wontfix`, and `fix` flows through developer rework before thread responses. | `DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING` |
| `ci_changes` routes from both PR routers to `ciRework` while `ciLoop < 3`, and `ciRework` returns to `integrator`. | `DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING` |
| `blockedEnd` remains a first-class `blocked` terminal. | `DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING` |
| Plan-review and code-review loop exhaustion route to human gates instead of dead-ending directly at `blockedEnd`. | `DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING` |

## Deferred #141 Rule

The scoped policy deliberately does not require a final merge-gate rejection reroute. While #141 is open,
`mergeGate` may still route a rejected/default decision to `blockedEnd`, and the static verifier must not emit a
passing or failing diagnostic that represents that as the final stale-approval behavior.

When #141 is implemented, update this spec and the verifier together with the graph/runtime change so the static rule
matches the landed behavior.

## Changelog

- 2026-06-28: Added scoped default-playbook policy for #145 with static rules separated from runtime evidence checks
  and #141 explicitly deferred.
