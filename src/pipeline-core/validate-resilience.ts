import { isDefaultBranch, isGuardedBranch } from './types.js';
import type { Branch, Condition, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { backwardReach, forwardReach, structuralEdges } from './validate-graph.js';

export function ruleResilienceWarnings(template: Template, d: DiagSink): void {
  ruleGateOutcomesExplicitlyRouted(template, d);
  ruleHumanGatesHaveCancelOfframp(template, d);
  ruleEffectFailuresRouted(template, d);
  ruleVerdictCyclesHaveCounterOrHumanGate(template, d);
}

function ruleGateOutcomesExplicitlyRouted(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind !== 'humanGate') continue;
    for (const outcome of node.outcomes) {
      if (node.branches.some((branch) => isGuardedBranch(branch) && conditionPositivelyMentionsVerdict(branch.when, outcome))) {
        continue;
      }
      d.error(
        'GATE_OUTCOME_UNROUTED',
        `humanGate ${node.id} declares outcome "${outcome}" but no guarded branch explicitly routes it`,
        { nodeId: node.id, path: `outcomes.${outcome}` },
      );
    }
  }
}

function ruleHumanGatesHaveCancelOfframp(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind !== 'humanGate') continue;
    const hasCancelOutcome = node.outcomes.includes('cancel');
    const hasCancelToCancelled = node.branches.some((branch) => {
      if (!isGuardedBranch(branch) || !conditionPositivelyMentionsVerdict(branch.when, 'cancel')) return false;
      const target = template.nodes[branch.goto];
      return target?.kind === 'terminal' && target.status === 'cancelled';
    });
    if (hasCancelOutcome && hasCancelToCancelled) continue;
    d.warn(
      'HUMAN_OFFRAMP_UNREACHABLE',
      `humanGate ${node.id} has no explicit cancel outcome routed to a cancelled terminal`,
      { nodeId: node.id },
    );
  }
}

function ruleEffectFailuresRouted(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'script') {
      const policy = node.onFailure ?? 'abort';
      if (policy === 'abort' && (node.catch ?? []).length === 0) {
        d.warn(
          'SCRIPT_FAILURE_UNROUTED',
          `script node ${node.id} can fail through the default abort path with no catch`,
          { nodeId: node.id },
        );
      }
    }
    if (node.kind === 'agent') {
      const policy = node.onFailure ?? 'abort';
      if (policy === 'abort') {
        d.warn(
          'AGENT_FAILURE_UNROUTED',
          `agent node ${node.id} uses abort failure policy instead of route or escalate`,
          { nodeId: node.id },
        );
      }
    }
  }
}

function ruleVerdictCyclesHaveCounterOrHumanGate(template: Template, d: DiagSink): void {
  const emitted = new Set<string>();
  for (const node of Object.values(template.nodes)) {
    if (node.kind !== 'choice' && node.kind !== 'humanGate') continue;
    for (const branch of node.branches) {
      if (!shouldWarnOnVerdictCycle(template, node.id, branch, emitted)) continue;
      d.error(
        'CYCLE_WITHOUT_COUNTER',
        `verdict branch ${node.id} → ${branch.goto} forms an automated cycle with no human gate or counter cap`,
        { nodeId: node.id },
      );
    }
  }
}

function shouldWarnOnVerdictCycle(
  template: Template,
  nodeId: string,
  branch: Branch,
  emitted: Set<string>,
): branch is Extract<Branch, { when: Condition; goto: string }> {
  if (!isRecheckVerdictBranch(branch)) return false;
  if (!forwardReach(template, branch.goto).has(nodeId)) return false;

  const cycle = cycleThroughEdge(template, nodeId, branch.goto);
  if (hasHumanGate(template, cycle)) return false;
  if (cycleHasCounterBound(template, cycle, 'recheck')) return false;

  const key = `${nodeId}->${branch.goto}`;
  if (emitted.has(key)) return false;
  emitted.add(key);
  return true;
}

function isRecheckVerdictBranch(branch: Branch): branch is Extract<Branch, { when: Condition; goto: string }> {
  return !isDefaultBranch(branch)
    && conditionPositivelyMentionsAnyVerdict(branch.when)
    && conditionPositivelyMentionsVerdict(branch.when, 'recheck');
}

function cycleThroughEdge(template: Template, from: string, to: string): Set<string> {
  const path = shortestPath(template, to, from);
  if (path) return new Set([from, ...path]);

  const reachableFromTarget = forwardReach(template, to);
  const canReachSource = backwardReach(template, from);
  const cycle = new Set<string>([from, to]);
  for (const id of reachableFromTarget) {
    if (canReachSource.has(id)) cycle.add(id);
  }
  return cycle;
}

function shortestPath(template: Template, start: string, target: string): string[] | null {
  const queue: string[][] = [[start]];
  const seen = new Set<string>([start]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path.at(-1)!;
    if (current === target) return path;
    const node = template.nodes[current];
    if (!node) continue;
    for (const [, next] of structuralEdges(node)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

function hasHumanGate(template: Template, cycle: Set<string>): boolean {
  return [...cycle].some((id) => template.nodes[id]?.kind === 'humanGate');
}

function cycleHasCounterBound(template: Template, cycle: Set<string>, verdict: string): boolean {
  const incremented = new Set<string>();
  for (const id of cycle) {
    const node = template.nodes[id];
    if (node && 'incrementCounters' in node) {
      for (const scope of node.incrementCounters ?? []) incremented.add(scope);
    }
  }
  if (incremented.size === 0) return false;
  return [...cycle].some((id) => {
    const node = template.nodes[id];
    if (node?.kind !== 'choice' && node?.kind !== 'humanGate') return false;
    return branchesHaveCounterBoundBeforeCycleContinues(node.branches, cycle, incremented, verdict);
  });
}

function branchesHaveCounterBoundBeforeCycleContinues(
  branches: Branch[],
  cycle: Set<string>,
  incremented: ReadonlySet<string>,
  verdict: string,
): boolean {
  let sawCycleBranch = false;
  for (const branch of branches) {
    if (!isGuardedBranch(branch)) continue;
    const staysInCycle = cycle.has(branch.goto);
    const appliesToVerdict = conditionCanApplyToVerdict(branch.when, verdict);
    const readsCounter = conditionHasCounterReadApplicableToVerdict(branch.when, incremented, verdict);
    if (readsCounter && (staysInCycle || !sawCycleBranch)) return true;
    if (staysInCycle && appliesToVerdict) sawCycleBranch = true;
  }
  return false;
}

function conditionHasCounterReadApplicableToVerdict(
  cond: Condition,
  scopes: ReadonlySet<string>,
  verdict: string,
): boolean {
  const summary = summarizeConditionForVerdict(cond, scopes, verdict);
  return summary.canBeTrue && summary.relevantCounterCanAffect;
}

function conditionCanApplyToVerdict(cond: Condition, verdict: string): boolean {
  return summarizeConditionForVerdict(cond, new Set<string>(), verdict).canBeTrue;
}

type ConditionVerdictSummary = {
  canBeTrue: boolean;
  canBeFalse: boolean;
  relevantCounterCanAffect: boolean;
};

function summarizeConditionForVerdict(
  cond: Condition,
  scopes: ReadonlySet<string>,
  verdict: string,
): ConditionVerdictSummary {
  switch (cond.op) {
    case 'verdict.eq':
      return constantCondition(cond.value === verdict);
    case 'verdict.in':
      return constantCondition(cond.value.includes(verdict));
    case 'counter.lt':
    case 'counter.gte':
      return { canBeTrue: true, canBeFalse: true, relevantCounterCanAffect: scopes.has(cond.scope) };
    case 'all':
      return summarizeAllCondition(cond.of.map((item) => summarizeConditionForVerdict(item, scopes, verdict)));
    case 'any':
      return summarizeAnyCondition(cond.of, cond.of.map((item) => summarizeConditionForVerdict(item, scopes, verdict)));
    case 'not': {
      const inner = summarizeConditionForVerdict(cond.cond, scopes, verdict);
      return {
        canBeTrue: inner.canBeFalse,
        canBeFalse: inner.canBeTrue,
        relevantCounterCanAffect: inner.relevantCounterCanAffect,
      };
    }
  }
}

function summarizeAllCondition(items: ConditionVerdictSummary[]): ConditionVerdictSummary {
  return {
    canBeTrue: items.every((item) => item.canBeTrue),
    canBeFalse: items.some((item) => item.canBeFalse),
    relevantCounterCanAffect: items.some(
      (item, index) => item.relevantCounterCanAffect && items.every((other, otherIndex) => otherIndex === index || other.canBeTrue),
    ),
  };
}

function summarizeAnyCondition(conditions: Condition[], items: ConditionVerdictSummary[]): ConditionVerdictSummary {
  if (hasComplementaryCounterDisjunction(conditions)) {
    return { canBeTrue: true, canBeFalse: false, relevantCounterCanAffect: false };
  }
  return {
    canBeTrue: items.some((item) => item.canBeTrue),
    canBeFalse: items.every((item) => item.canBeFalse),
    relevantCounterCanAffect: items.some(
      (item, index) => item.relevantCounterCanAffect && items.every((other, otherIndex) => otherIndex === index || other.canBeFalse),
    ),
  };
}

function constantCondition(value: boolean): ConditionVerdictSummary {
  return { canBeTrue: value, canBeFalse: !value, relevantCounterCanAffect: false };
}

function hasComplementaryCounterDisjunction(conditions: Condition[]): boolean {
  const gteByScope = new Map<string, number[]>();
  const ltByScope = new Map<string, number[]>();
  for (const condition of conditions) {
    if (condition.op !== 'counter.gte' && condition.op !== 'counter.lt') continue;
    if (condition.op === 'counter.gte') {
      if ((ltByScope.get(condition.scope) ?? []).some((value) => value >= condition.value)) return true;
      const values = gteByScope.get(condition.scope) ?? [];
      values.push(condition.value);
      gteByScope.set(condition.scope, values);
    } else {
      if ((gteByScope.get(condition.scope) ?? []).some((value) => condition.value >= value)) return true;
      const values = ltByScope.get(condition.scope) ?? [];
      values.push(condition.value);
      ltByScope.set(condition.scope, values);
    }
  }
  return false;
}

function conditionPositivelyMentionsAnyVerdict(cond: Condition): boolean {
  switch (cond.op) {
    case 'verdict.eq':
    case 'verdict.in':
      return true;
    case 'all':
    case 'any':
      return cond.of.some(conditionPositivelyMentionsAnyVerdict);
    case 'not':
      return false;
    default:
      return false;
  }
}

function conditionPositivelyMentionsVerdict(cond: Condition, verdict: string): boolean {
  switch (cond.op) {
    case 'verdict.eq':
      return cond.value === verdict;
    case 'verdict.in':
      return cond.value.includes(verdict);
    case 'all':
    case 'any':
      return cond.of.some((item) => conditionPositivelyMentionsVerdict(item, verdict));
    case 'not':
      return false;
    default:
      return false;
  }
}
