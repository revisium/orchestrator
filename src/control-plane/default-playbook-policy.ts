import type { Branch, Condition, Node, Template } from '../pipeline-core/types.js';

export const DEFAULT_PLAYBOOK_POLICY_DIAGNOSTIC_CODES = [
  'DEFAULT_POLICY_WRONG_PIPELINE',
  'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
  'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
  'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
  'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
  'DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING',
  'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
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

export function validateDefaultFeatureDevelopmentPolicy(
  template: Template,
): DefaultPlaybookPolicyDiagnostic[] {
  const sink = new PolicySink(template.pipelineId);

  if (template.pipelineId !== 'feature-development') {
    sink.error(
      'DEFAULT_POLICY_WRONG_PIPELINE',
      'default playbook policy verifier only applies to feature-development',
      { expected: 'feature-development', actual: template.pipelineId },
    );
    return sink.diagnostics;
  }

  checkBlockedTerminal(template, sink);
  checkProducedChangeHandoff(template, sink);
  checkPrFreshnessWiring(template, sink);
  checkReviewFeedbackLoop(template, sink);
  checkLoopExhaustionEscalation(template, sink);

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

function checkProducedChangeHandoff(template: Template, sink: PolicySink): void {
  for (const nodeId of ['developer', 'reworkDeveloper', 'ciRework', 'reviewRework']) {
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
  expectRoute(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    nodeId: 'mergeGate',
    verdict: 'approved',
    target: 'confirmMerge',
  });
  expectConsume(template, sink, {
    code: 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
    consumerId: 'confirmMerge',
    producerId: 'mergeReadiness',
    as: 'mergeReadiness',
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
  expectRouterDefaultGate(template, sink, {
    routerId: 'planReviewRouter',
    gateId: 'planStuckGate',
    approveTarget: 'developer',
  });
  expectRouterDefaultGate(template, sink, {
    routerId: 'codeReviewRouter',
    gateId: 'codeStuckGate',
    approveTarget: 'integrator',
  });
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

function expectRouterDefaultGate(
  template: Template,
  sink: PolicySink,
  rule: { routerId: string; gateId: string; approveTarget: string },
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
  const approveTarget = gate ? guardedTargetForVerdict(gate, 'approved') : undefined;
  const gateDefault = gate ? defaultBranchTarget(gate) : undefined;
  if (gate?.kind === 'humanGate' && approveTarget === rule.approveTarget && gateDefault === 'blockedEnd') return;

  sink.error(
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    `loop exhaustion gate ${rule.gateId} must approve to ${rule.approveTarget} and reject to blockedEnd`,
    {
      nodeId: rule.gateId,
      path: 'branches',
      expected: `humanGate approved -> ${rule.approveTarget}, default -> blockedEnd`,
      actual: gate ? `kind=${gate.kind} approved=${approveTarget ?? 'missing'} default=${gateDefault ?? 'missing'}` : 'missing gate',
    },
  );
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
