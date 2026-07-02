import type { Branch, Condition, Node, Template } from '../pipeline-core/types.js';

export const DEFAULT_PLAYBOOK_POLICY_DIAGNOSTIC_CODES = [
  'DEFAULT_POLICY_WRONG_PIPELINE',
  'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
  'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
  'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
  'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
  'DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING',
  'DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING',
  'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  'DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL',
  'DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING',
  'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
  'DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING',
  'DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL',
  'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
  'DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT',
  'DEFAULT_POLICY_VARIANT_POLICY_GAP',
  'DEFAULT_POLICY_VARIANT_PARITY_DRIFT',
] as const;

export type DefaultPlaybookPolicyDiagnosticCode =
  (typeof DEFAULT_PLAYBOOK_POLICY_DIAGNOSTIC_CODES)[number];

export type DefaultPlaybookPolicyDiagnostic = {
  code: DefaultPlaybookPolicyDiagnosticCode;
  severity: 'error';
  message: string;
  pipelineId: string;
  nodeId?: string;
  path?: string;
  expected?: string;
  actual?: string;
};

type EffectNode = Extract<Node, { kind: 'agent' | 'script' }>;
type RoutingNode = Extract<Node, { kind: 'choice' | 'humanGate' }>;

const SUPPORTED_PIPELINE_IDS = ['feature-development', 'feature-development-codex-consensus'] as const;

// #242 debt snapshot — codes the reconciled rule set emits on feature-development-codex-consensus today.
// When #242 reconciles the codex graph this set empties and VARIANT_PARITY_DRIFT fires, prompting removal.
// To update: run validateDefaultPlaybookPolicy(codexTemplate), capture the unique code set, replace below.
const CODEX_LEGACY_WAIVERS: readonly DefaultPlaybookPolicyDiagnosticCode[] = [
  'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
  'DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING',
  'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
  'DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL',
  'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  'DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING',
  'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
  'DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL',
  'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
] as const;

class PolicySink {
  readonly diagnostics: DefaultPlaybookPolicyDiagnostic[] = [];

  constructor(private readonly pipelineId: string) {}

  error(
    code: DefaultPlaybookPolicyDiagnosticCode,
    message: string,
    where: Omit<Partial<DefaultPlaybookPolicyDiagnostic>, 'code' | 'severity' | 'message' | 'pipelineId'> = {},
  ): void {
    this.diagnostics.push({
      code,
      severity: 'error',
      message,
      pipelineId: this.pipelineId,
      ...where,
    });
  }
}

export function validateDefaultPlaybookPolicy(
  template: Template,
): DefaultPlaybookPolicyDiagnostic[] {
  const sink = new PolicySink(template.pipelineId);

  if (!(SUPPORTED_PIPELINE_IDS as readonly string[]).includes(template.pipelineId)) {
    sink.error(
      'DEFAULT_POLICY_WRONG_PIPELINE',
      'default playbook policy verifier only applies to feature-development variants',
      { expected: SUPPORTED_PIPELINE_IDS.join('|'), actual: template.pipelineId },
    );
    return sink.diagnostics;
  }

  checkBlockedTerminal(template, sink);
  checkCancelledTerminal(template, sink);
  checkProducedChangeHandoff(template, sink);
  checkPrFreshnessWiring(template, sink);
  checkApproveReverifyBeforeMerge(template, sink);
  checkMergeConsumesFreshReadiness(template, sink);
  checkMergeGateRecheckRouting(template, sink);
  checkReviewFeedbackLoop(template, sink);
  checkLoopExhaustionEscalation(template, sink);
  checkRecoverableCatches(template, sink);
  checkCapExhaustionOffRamp(template, sink);
  checkConfirmMergeFailureRecoverable(template, sink);
  checkPostMergeCleanup(template, sink);
  checkGateOutcomesExplicit(template, sink);

  return sink.diagnostics;
}

export function validateVariantParity(template: Template): DefaultPlaybookPolicyDiagnostic[] {
  const sink = new PolicySink(template.pipelineId);

  const actualCodes = new Set(validateDefaultPlaybookPolicy(template).map((d) => d.code));
  const waivedCodes = new Set<DefaultPlaybookPolicyDiagnosticCode>(CODEX_LEGACY_WAIVERS);

  for (const code of actualCodes) {
    if (!waivedCodes.has(code)) {
      sink.error(
        'DEFAULT_POLICY_VARIANT_POLICY_GAP',
        `codex variant fires ${code} but it is not listed in CODEX_LEGACY_WAIVERS`,
        { expected: 'code listed in CODEX_LEGACY_WAIVERS', actual: code },
      );
    }
  }

  const actualSorted = [...actualCodes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
  const waivedSorted = [...waivedCodes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
  if (actualSorted !== waivedSorted) {
    sink.error(
      'DEFAULT_POLICY_VARIANT_PARITY_DRIFT',
      'codex variant violation set differs from CODEX_LEGACY_WAIVERS',
      { expected: waivedSorted, actual: actualSorted },
    );
  }

  return sink.diagnostics;
}

function checkBlockedTerminal(template: Template, sink: PolicySink): void {
  const blockedEnd = template.nodes['blockedEnd'];
  if (blockedEnd?.kind === 'terminal' && blockedEnd.status === 'blocked') return;

  sink.error(
    'DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING',
    'feature-development must keep blockedEnd as a first-class blocked terminal',
    {
      nodeId: 'blockedEnd',
      expected: 'terminal status=blocked',
      actual: blockedEnd ? `${blockedEnd.kind}${'status' in blockedEnd ? ` status=${blockedEnd.status}` : ''}` : 'missing',
    },
  );
}

function checkCancelledTerminal(template: Template, sink: PolicySink): void {
  const cancelledEnd = template.nodes['cancelledEnd'];
  if (cancelledEnd?.kind === 'terminal' && cancelledEnd.status === 'cancelled') return;

  sink.error(
    'DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING',
    'feature-development must keep cancelledEnd as a first-class cancelled terminal',
    {
      nodeId: 'cancelledEnd',
      expected: 'terminal status=cancelled',
      actual: cancelledEnd ? `${cancelledEnd.kind}${'status' in cancelledEnd ? ` status=${cancelledEnd.status}` : ''}` : 'missing',
    },
  );
}

function checkProducedChangeHandoff(template: Template, sink: PolicySink): void {
  for (const nodeId of ['developer', 'reworkDeveloper', 'stuckReworkDeveloper', 'ciRework', 'reviewRework']) {
    expectChangeProducer(template, sink, nodeId);
  }

  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'codeReview',
    producerId: 'developer',
    as: 'developerChange',
    staleOk: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'codeReview',
    producerId: 'reworkDeveloper',
    as: 'reworkChange',
    optional: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'integrator',
    producerId: 'developer',
    as: 'developerChange',
    staleOk: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'integrator',
    producerId: 'reworkDeveloper',
    as: 'reworkChange',
    optional: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'integrator',
    producerId: 'stuckReworkDeveloper',
    as: 'stuckReworkChange',
    optional: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'integrator',
    producerId: 'ciRework',
    as: 'ciChange',
    optional: true,
    staleOk: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    consumerId: 'reviewIntegrator',
    producerId: 'reviewRework',
    as: 'reviewChange',
  });
}

function checkPrFreshnessWiring(template: Template, sink: PolicySink): void {
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    nodeId: 'pollPr',
    scriptRef: 'script:pollPr',
    next: 'prRouter',
    resultSchema: 'schema:prFeedback',
    produces: 'prFeedback',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    nodeId: 'prRouter',
    verdict: 'clean',
    target: 'mergeReadiness',
  });
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    nodeId: 'mergeReadiness',
    scriptRef: 'script:pollPr',
    next: 'mergeReadinessRouter',
    resultSchema: 'schema:prFeedback',
    produces: 'prFeedback',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    nodeId: 'mergeReadinessRouter',
    verdict: 'clean',
    target: 'mergeGate',
  });
  expectGateArtifact(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    nodeId: 'mergeGate',
    producerId: 'mergeReadiness',
    as: 'prFeedback',
  });
}

function checkApproveReverifyBeforeMerge(template: Template, sink: PolicySink): void {
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
    nodeId: 'mergeGate',
    verdict: 'approved',
    target: 'mergeApproveReverify',
  });
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
    nodeId: 'mergeApproveReverify',
    scriptRef: 'script:pollPr',
    next: 'mergeApproveReverifyRouter',
    resultSchema: 'schema:prFeedback',
    produces: 'prFeedback',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
    nodeId: 'mergeApproveReverifyRouter',
    verdict: 'clean',
    target: 'confirmMerge',
  });
}

function checkMergeConsumesFreshReadiness(template: Template, sink: PolicySink): void {
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING',
    consumerId: 'confirmMerge',
    producerId: 'mergeApproveReverify',
    as: 'mergeReadiness',
  });
}

function checkMergeGateRecheckRouting(template: Template, sink: PolicySink): void {
  expectGateOutcomes(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeGate',
    outcomes: ['approved', 'recheck', 'address_review_threads', 'return_to_development', 'override_merge', 'cancel'],
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeGate',
    verdict: 'recheck',
    target: 'mergeRecheck',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeGate',
    verdict: 'address_review_threads',
    target: 'triage',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeGate',
    verdict: 'return_to_development',
    target: 'triage',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeGate',
    verdict: 'override_merge',
    target: 'mergeApproveReverify',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeGate',
    verdict: 'cancel',
    target: 'cancelledEnd',
  });
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeRecheck',
    scriptRef: 'script:pollPr',
    next: 'mergeRecheckRouter',
    resultSchema: 'schema:prFeedback',
    produces: 'prFeedback',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeRecheckRouter',
    verdict: 'clean',
    target: 'blockedEnd',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeRecheckRouter',
    verdict: 'review_changes',
    target: 'triage',
  });
  expectBoundedRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeRecheckRouter',
    verdict: 'ci_changes',
    target: 'ciRework',
    scope: 'ciLoop',
    value: 3,
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeRecheckRouter',
    verdict: 'recheck',
    target: 'mergeReadiness',
  });
  expectDefaultRoute(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    nodeId: 'mergeRecheckRouter',
    target: 'recoveryGate',
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    consumerId: 'triage',
    producerId: 'mergeRecheck',
    as: 'recheckFeedback',
    optional: true,
    staleOk: true,
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    consumerId: 'ciRework',
    producerId: 'mergeRecheck',
    as: 'recheckFeedback',
    optional: true,
    staleOk: true,
  });
}

function checkReviewFeedbackLoop(template: Template, sink: PolicySink): void {
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'prRouter',
    verdict: 'review_changes',
    target: 'triage',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'mergeReadinessRouter',
    verdict: 'review_changes',
    target: 'triage',
  });
  expectBoundedRoute(template, sink, {
    code: 'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
    nodeId: 'prRouter',
    verdict: 'ci_changes',
    target: 'ciRework',
    scope: 'ciLoop',
    value: 3,
  });
  expectBoundedRoute(template, sink, {
    code: 'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
    nodeId: 'mergeReadinessRouter',
    verdict: 'ci_changes',
    target: 'ciRework',
    scope: 'ciLoop',
    value: 3,
  });
  expectNodeNext(template, sink, {
    code: 'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
    nodeId: 'ciRework',
    target: 'integrator',
  });
  expectAgent(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'triage',
    roleRef: 'role:triager',
    next: 'triageRouter',
    resultSchema: 'schema:triage',
    produces: 'triage',
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    consumerId: 'triage',
    producerId: 'pollPr',
    as: 'feedback',
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    consumerId: 'triage',
    producerId: 'mergeReadiness',
    as: 'mergeFeedback',
    optional: true,
    staleOk: true,
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'triageRouter',
    verdict: 'question',
    target: 'questionGate',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'triageRouter',
    verdict: 'fix',
    target: 'reviewRework',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'triageRouter',
    verdict: 'wontfix',
    target: 'respondThreads',
  });
  expectNodeNext(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'reviewRework',
    target: 'reviewIntegrator',
  });
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'reviewIntegrator',
    scriptRef: 'script:integrator',
    next: 'respondThreads',
    resultSchema: 'schema:integration',
  });
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    nodeId: 'respondThreads',
    scriptRef: 'script:respondThreads',
    next: 'pollPr',
    resultSchema: 'schema:respond',
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    consumerId: 'respondThreads',
    producerId: 'triage',
    as: 'triage',
  });
}

function checkLoopExhaustionEscalation(template: Template, sink: PolicySink): void {
  expectHumanGateOutcomes(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'planGate',
    outcomes: ['approved', 'rework', 'cancel'],
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'planGate',
    verdict: 'rework',
    target: 'analyst',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'planGate',
    verdict: 'cancel',
    target: 'cancelledEnd',
  });
  expectRouterDefaultGate(template, sink, {
    routerId: 'planReviewRouter',
    gateId: 'planStuckGate',
    approveTarget: 'developer',
  });
  expectHumanGateOutcomes(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'planStuckGate',
    outcomes: ['approved', 'rework', 'cancel'],
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'planStuckGate',
    verdict: 'rework',
    target: 'analyst',
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'planStuckGate',
    verdict: 'cancel',
    target: 'cancelledEnd',
  });
  expectRouterDefaultGate(template, sink, {
    routerId: 'codeReviewRouter',
    gateId: 'codeStuckGate',
    approveTarget: 'integrator',
    approveVerdict: 'approve_anyway',
  });
  expectNodeNext(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'stuckReworkDeveloper',
    target: template.nodes['codeReviewFanout'] ? 'codeReviewFanout' : 'codeReview',
  });
  expectBoundedRoute(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'codeStuckGate',
    verdict: 'rework',
    target: 'stuckReworkDeveloper',
    scope: 'codeStuckRecoveryLoop',
    value: 3,
  });
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'codeStuckGate',
    verdict: 'cancel',
    target: 'cancelledEnd',
  });
  expectHumanGateOutcomes(template, sink, {
    code: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    nodeId: 'codeStuckGate',
    outcomes: ['approve_anyway', 'rework', 'cancel'],
  });
  expectScopeConfig(template, sink, {
    scopeId: 'codeReviewLoop',
    cap: 3,
    parent: 'codeStuckRecoveryLoop',
  });
  expectScopeConfig(template, sink, {
    scopeId: 'codeStuckRecoveryLoop',
    cap: 3,
    parent: null,
  });
}

function checkRecoverableCatches(template: Template, sink: PolicySink): void {
  const recoverableNodes = [
    'pollPr',
    'mergeReadiness',
    'mergeRecheck',
    'mergeApproveReverify',
    'integrator',
    'reviewIntegrator',
    'respondThreads',
  ];

  for (const nodeId of recoverableNodes) {
    const node = effectNode(template, nodeId);
    if (!node) continue;
    for (const entry of node.catch ?? []) {
      if (isTerminalNode(template, entry.goto)) {
        sink.error(
          'DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL',
          `node ${nodeId} catch for ${entry.onError} must not route to a terminal`,
          {
            nodeId,
            expected: `${entry.onError} -> non-terminal`,
            actual: `${entry.onError} -> ${entry.goto}`,
          },
        );
      }
    }
  }
}

function checkCapExhaustionOffRamp(template: Template, sink: PolicySink): void {
  const capRouters = [
    'prRouter',
    'mergeReadinessRouter',
    'mergeRecheckRouter',
    'triageRouter',
    'recoveryRouter',
    'planReviewRouter',
    'codeReviewRouter',
  ];

  for (const nodeId of capRouters) {
    const node = routingNode(template, nodeId);
    if (!node) continue;
    const target = defaultBranchTarget(node);
    const targetNode = target ? template.nodes[target] : undefined;
    const isHumanGate = targetNode?.kind === 'humanGate';
    const isClassifier = target === 'classifyRecovery';
    if (!isHumanGate && !isClassifier) {
      sink.error(
        'DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING',
        `cap-router ${nodeId} default must route to a humanGate or classifyRecovery, not a terminal`,
        {
          nodeId,
          expected: 'default -> humanGate or classifyRecovery',
          actual: target ? `default -> ${target} (${targetNode?.kind ?? 'missing'})` : 'missing default branch',
        },
      );
    }
  }
}

function checkConfirmMergeFailureRecoverable(template: Template, sink: PolicySink): void {
  const node = effectNode(template, 'confirmMerge');
  if (!node) return;
  for (const entry of node.catch ?? []) {
    if (isTerminalNode(template, entry.goto)) {
      sink.error(
        'DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL',
        `confirmMerge catch for ${entry.onError} must not route to a terminal`,
        {
          nodeId: 'confirmMerge',
          expected: `${entry.onError} -> non-terminal`,
          actual: `${entry.onError} -> ${entry.goto}`,
        },
      );
    }
  }
}

function checkPostMergeCleanup(template: Template, sink: PolicySink): void {
  expectNodeNext(template, sink, {
    code: 'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
    nodeId: 'confirmMerge',
    target: 'cleanupWorktree',
  });
  expectScript(template, sink, {
    code: 'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
    nodeId: 'cleanupWorktree',
    scriptRef: 'script:cleanupWorktree',
    next: 'mergedEnd',
    resultSchema: 'schema:integration',
  });
}

function checkGateOutcomesExplicit(template: Template, sink: PolicySink): void {
  for (const [nodeId, node] of Object.entries(template.nodes)) {
    if (node.kind !== 'humanGate') continue;
    for (const outcome of node.outcomes) {
      if (outcome !== 'cancel' && outcome !== 'rework') continue;
      const branch = guardedBranchForVerdict(node, outcome);
      if (!branch) {
        sink.error(
          'DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT',
          `gate ${nodeId} declares ${outcome} but has no guarded branch for it`,
          {
            nodeId,
            expected: `guarded branch for ${outcome}`,
            actual: 'missing guarded branch',
          },
        );
      }
    }
  }
}

function expectChangeProducer(template: Template, sink: PolicySink, nodeId: string): void {
  const node = effectNode(template, nodeId);
  if (node?.resultSchema === 'schema:change' && node.produces?.name === 'change') return;

  sink.error(
    'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
    `node ${nodeId} must produce a schema:change artifact named change`,
    {
      nodeId,
      expected: 'resultSchema=schema:change produces.name=change',
      actual: describeEffect(node),
    },
  );
}

function expectAgent(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    nodeId: string;
    roleRef: string;
    next: string;
    resultSchema: string;
    produces?: string;
  },
): void {
  const node = template.nodes[rule.nodeId];
  if (
    node?.kind === 'agent' &&
    node.roleRef === rule.roleRef &&
    node.next === rule.next &&
    node.resultSchema === rule.resultSchema &&
    (rule.produces === undefined || node.produces?.name === rule.produces)
  ) {
    return;
  }

  sink.error(rule.code, `node ${rule.nodeId} must be ${rule.roleRef} and route to ${rule.next}`, {
    nodeId: rule.nodeId,
    expected: `agent ${rule.roleRef} next=${rule.next} resultSchema=${rule.resultSchema}`,
    actual: describeNode(node),
  });
}

function expectScript(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    nodeId: string;
    scriptRef: string;
    next: string;
    resultSchema: string;
    produces?: string;
  },
): void {
  const node = template.nodes[rule.nodeId];
  if (
    node?.kind === 'script' &&
    node.scriptRef === rule.scriptRef &&
    node.next === rule.next &&
    node.resultSchema === rule.resultSchema &&
    (rule.produces === undefined || node.produces?.name === rule.produces)
  ) {
    return;
  }

  sink.error(rule.code, `node ${rule.nodeId} must be ${rule.scriptRef} and route to ${rule.next}`, {
    nodeId: rule.nodeId,
    expected: `script ${rule.scriptRef} next=${rule.next} resultSchema=${rule.resultSchema}`,
    actual: describeNode(node),
  });
}

function expectGateOutcomes(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    nodeId: string;
    outcomes: string[];
  },
): void {
  const node = template.nodes[rule.nodeId];
  if (
    node?.kind === 'humanGate' &&
    node.outcomes.length === rule.outcomes.length &&
    node.outcomes.every((outcome, index) => outcome === rule.outcomes[index])
  ) {
    return;
  }

  sink.error(
    rule.code,
    `gate ${rule.nodeId} must map approve to ${rule.outcomes[0]} and reject to ${rule.outcomes.at(-1)}`,
    {
      nodeId: rule.nodeId,
      path: 'outcomes',
      expected: rule.outcomes.join(','),
      actual: node?.kind === 'humanGate' ? node.outcomes.join(',') : describeNode(node),
    },
  );
}

function expectConsume(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    consumerId: string;
    producerId: string;
    as: string;
    optional?: boolean;
    staleOk?: boolean;
  },
): void {
  const consumer = effectNode(template, rule.consumerId);
  const ref = consumer?.consumes?.find((candidate) => candidate.node === rule.producerId);

  if (
    ref?.as === rule.as &&
    Boolean(ref.optional) === Boolean(rule.optional) &&
    Boolean(ref.staleOk) === Boolean(rule.staleOk)
  ) {
    return;
  }

  sink.error(
    rule.code,
    `node ${rule.consumerId} must consume ${rule.producerId} as ${rule.as}`,
    {
      nodeId: rule.consumerId,
      path: 'consumes',
      expected: consumeExpectation(rule),
      actual: ref ? consumeDescription(ref) : consumer ? 'missing consume ref' : 'missing consumer',
    },
  );
}

function expectNodeNext(
  template: Template,
  sink: PolicySink,
  rule: { code: DefaultPlaybookPolicyDiagnosticCode; nodeId: string; target: string },
): void {
  const node = effectNode(template, rule.nodeId);
  if (node?.next === rule.target) return;

  sink.error(rule.code, `node ${rule.nodeId} must route to ${rule.target}`, {
    nodeId: rule.nodeId,
    path: 'next',
    expected: rule.target,
    actual: node?.next ?? describeNode(template.nodes[rule.nodeId]),
  });
}

function expectDefaultRoute(
  template: Template,
  sink: PolicySink,
  rule: { code: DefaultPlaybookPolicyDiagnosticCode; nodeId: string; target: string },
): void {
  const node = routingNode(template, rule.nodeId);
  const actual = node ? defaultBranchTarget(node) : undefined;
  if (actual === rule.target) return;

  sink.error(rule.code, `node ${rule.nodeId} must route default to ${rule.target}`, {
    nodeId: rule.nodeId,
    path: 'branches.default',
    expected: `default -> ${rule.target}`,
    actual: actual ?? (node ? 'missing default route' : 'missing routing node'),
  });
}

function expectRoute(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    nodeId: string;
    verdict: string;
    target: string;
  },
): void {
  const node = routingNode(template, rule.nodeId);
  const actual = node ? guardedTargetForVerdict(node, rule.verdict) : undefined;
  if (actual === rule.target) return;

  sink.error(rule.code, `node ${rule.nodeId} must route ${rule.verdict} to ${rule.target}`, {
    nodeId: rule.nodeId,
    path: 'branches',
    expected: `${rule.verdict} -> ${rule.target}`,
    actual: actual ?? (node ? 'missing verdict route' : 'missing routing node'),
  });
}

function expectBoundedRoute(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    nodeId: string;
    verdict: string;
    target: string;
    scope: string;
    value: number;
  },
): void {
  const node = routingNode(template, rule.nodeId);
  const branch = node ? guardedBranchForVerdict(node, rule.verdict) : undefined;
  const isBoundedConjunction = branch
    ? conditionIsConjunctiveVerdictAndCounterLt(branch.when, rule.verdict, rule.scope, rule.value)
    : false;

  if (branch?.goto === rule.target && isBoundedConjunction) {
    return;
  }

  sink.error(
    rule.code,
    `node ${rule.nodeId} must route ${rule.verdict} to ${rule.target} while ${rule.scope} < ${rule.value}`,
    {
      nodeId: rule.nodeId,
      path: 'branches',
      expected: `${rule.verdict} + ${rule.scope}<${rule.value} -> ${rule.target}`,
      actual: branch
        ? `${rule.verdict} -> ${branch.goto}, conjunctiveBound=${isBoundedConjunction}`
        : node
          ? 'missing verdict route'
          : 'missing routing node',
    },
  );
}

function expectGateArtifact(
  template: Template,
  sink: PolicySink,
  rule: {
    code: DefaultPlaybookPolicyDiagnosticCode;
    nodeId: string;
    producerId: string;
    as: string;
  },
): void {
  const node = template.nodes[rule.nodeId];
  if (node?.kind === 'humanGate' && node.gatedArtifact?.node === rule.producerId && node.gatedArtifact.as === rule.as) {
    return;
  }

  sink.error(rule.code, `gate ${rule.nodeId} must surface ${rule.producerId} as ${rule.as}`, {
    nodeId: rule.nodeId,
    path: 'gatedArtifact',
    expected: `node=${rule.producerId} as=${rule.as}`,
    actual: node?.kind === 'humanGate' && node.gatedArtifact
      ? `node=${node.gatedArtifact.node} as=${node.gatedArtifact.as ?? ''}`
      : describeNode(node),
  });
}

function expectScopeConfig(
  template: Template,
  sink: PolicySink,
  rule: { scopeId: string; cap: number; parent: string | null },
): void {
  const scope = template.scopes?.[rule.scopeId];
  if (scope?.cap === rule.cap && scope.parent === rule.parent) return;

  sink.error(
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    `scope ${rule.scopeId} must have cap ${rule.cap} and parent ${String(rule.parent)}`,
    {
      path: `scopes.${rule.scopeId}`,
      expected: `cap=${rule.cap} parent=${String(rule.parent)}`,
      actual: scope ? `cap=${scope.cap} parent=${String(scope.parent)}` : 'missing scope',
    },
  );
}

function expectHumanGateOutcomes(
  template: Template,
  sink: PolicySink,
  rule: { code: DefaultPlaybookPolicyDiagnosticCode; nodeId: string; outcomes: string[] },
): void {
  const node = template.nodes[rule.nodeId];
  const expected = rule.outcomes.join(',');
  const actual = node?.kind === 'humanGate' ? node.outcomes.join(',') : describeNode(node);
  if (actual === expected) return;

  sink.error(rule.code, `gate ${rule.nodeId} must declare explicit outcomes ${expected}`, {
    nodeId: rule.nodeId,
    path: 'outcomes',
    expected,
    actual,
  });
}

function expectRouterDefaultGate(
  template: Template,
  sink: PolicySink,
  rule: { routerId: string; gateId: string; approveTarget: string; approveVerdict?: string },
): void {
  const router = routingNode(template, rule.routerId);
  const defaultTarget = router ? defaultBranchTarget(router) : undefined;
  if (defaultTarget !== rule.gateId) {
    sink.error(
      'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
      `loop exhaustion at ${rule.routerId} must route to ${rule.gateId}`,
      {
        nodeId: rule.routerId,
        path: 'branches.default',
        expected: rule.gateId,
        actual: defaultTarget ?? (router ? 'missing default route' : 'missing router'),
      },
    );
    return;
  }

  const gate = routingNode(template, rule.gateId);
  const approveVerdict = rule.approveVerdict ?? 'approved';
  const approveTarget = gate ? guardedTargetForVerdict(gate, approveVerdict) : undefined;
  const gateDefault = gate ? defaultBranchTarget(gate) : undefined;
  if (gate?.kind === 'humanGate' && approveTarget === rule.approveTarget && gateDefault === 'blockedEnd') return;

  sink.error(
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    `loop exhaustion gate ${rule.gateId} must approve to ${rule.approveTarget} and reject to blockedEnd`,
    {
      nodeId: rule.gateId,
      path: 'branches',
      expected: `humanGate ${approveVerdict} -> ${rule.approveTarget}, default -> blockedEnd`,
      actual: gate ? `kind=${gate.kind} ${approveVerdict}=${approveTarget ?? 'missing'} default=${gateDefault ?? 'missing'}` : 'missing gate',
    },
  );
}

function isTerminalNode(template: Template, nodeId: string): boolean {
  return template.nodes[nodeId]?.kind === 'terminal';
}

function effectNode(template: Template, nodeId: string): EffectNode | undefined {
  const node = template.nodes[nodeId];
  if (node?.kind === 'agent' || node?.kind === 'script') return node;
  return undefined;
}

function routingNode(template: Template, nodeId: string): RoutingNode | undefined {
  const node = template.nodes[nodeId];
  if (node?.kind === 'choice' || node?.kind === 'humanGate') return node;
  return undefined;
}

function guardedTargetForVerdict(node: RoutingNode, verdict: string): string | undefined {
  return guardedBranchForVerdict(node, verdict)?.goto;
}

function guardedBranchForVerdict(
  node: RoutingNode,
  verdict: string,
): Extract<Branch, { when: Condition; goto: string }> | undefined {
  const branch = node.branches.find((candidate) =>
    isGuardedBranch(candidate) && conditionMentionsVerdict(candidate.when, verdict),
  );
  if (branch && isGuardedBranch(branch)) return branch;
  return undefined;
}

function defaultBranchTarget(node: RoutingNode): string | undefined {
  return node.branches.find(isDefaultBranch)?.default;
}

function conditionMentionsVerdict(condition: Condition, verdict: string): boolean {
  switch (condition.op) {
    case 'verdict.eq':
      return condition.value === verdict;
    case 'verdict.in':
      return condition.value.includes(verdict);
    case 'all':
    case 'any':
      return condition.of.some((inner) => conditionMentionsVerdict(inner, verdict));
    case 'not':
      return false;
    case 'counter.lt':
    case 'counter.gte':
      return false;
  }
}

function conditionIsConjunctiveVerdictAndCounterLt(
  condition: Condition,
  verdict: string,
  scope: string,
  value: number,
): boolean {
  if (condition.op !== 'all') return false;
  return condition.of.some((inner) => conditionIsExactVerdictPredicate(inner, verdict)) &&
    condition.of.some((inner) => conditionIsExactCounterLtPredicate(inner, scope, value));
}

function conditionIsExactVerdictPredicate(condition: Condition, verdict: string): boolean {
  switch (condition.op) {
    case 'verdict.eq':
      return condition.value === verdict;
    case 'verdict.in':
      return condition.value.includes(verdict);
    case 'all':
    case 'any':
    case 'not':
    case 'counter.lt':
    case 'counter.gte':
      return false;
  }
}

function conditionIsExactCounterLtPredicate(condition: Condition, scope: string, value: number): boolean {
  switch (condition.op) {
    case 'counter.lt':
      return condition.scope === scope && condition.value === value;
    case 'all':
    case 'not':
    case 'any':
    case 'verdict.eq':
    case 'verdict.in':
    case 'counter.gte':
      return false;
  }
}

function isGuardedBranch(branch: Branch): branch is Extract<Branch, { when: Condition; goto: string }> {
  return 'when' in branch;
}

function isDefaultBranch(branch: Branch): branch is Extract<Branch, { default: string }> {
  return 'default' in branch;
}

function consumeExpectation(rule: {
  producerId: string;
  as: string;
  optional?: boolean;
  staleOk?: boolean;
}): string {
  return [
    `node=${rule.producerId}`,
    `as=${rule.as}`,
    `optional=${Boolean(rule.optional)}`,
    `staleOk=${Boolean(rule.staleOk)}`,
  ].join(' ');
}

function consumeDescription(ref: { node: string; as: string; optional?: boolean; staleOk?: boolean }): string {
  return [
    `node=${ref.node}`,
    `as=${ref.as}`,
    `optional=${Boolean(ref.optional)}`,
    `staleOk=${Boolean(ref.staleOk)}`,
  ].join(' ');
}

function describeEffect(node: EffectNode | undefined): string {
  if (!node) return 'missing or not an effect node';
  return `kind=${node.kind} resultSchema=${node.resultSchema ?? ''} produces=${node.produces?.name ?? ''}`;
}

function describeNode(node: Node | undefined): string {
  if (!node) return 'missing';
  if (node.kind === 'agent') return `agent ${node.roleRef} next=${node.next} resultSchema=${node.resultSchema ?? ''}`;
  if (node.kind === 'script') return `script ${node.scriptRef} next=${node.next} resultSchema=${node.resultSchema ?? ''}`;
  if (node.kind === 'terminal') return `terminal status=${node.status}`;
  return node.kind;
}
