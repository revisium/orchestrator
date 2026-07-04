import { isDefaultBranch, isGuardedBranch } from './types.js';
import type { Condition, Template } from './types.js';
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
      d.warn(
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
      if (isDefaultBranch(branch) || !conditionPositivelyMentionsAnyVerdict(branch.when)) continue;
      if (!conditionPositivelyMentionsVerdict(branch.when, 'recheck')) continue;
      if (!forwardReach(template, branch.goto).has(node.id)) continue;

      const cycle = cycleThroughEdge(template, node.id, branch.goto);
      if (hasHumanGate(template, cycle)) continue;
      if (cycleHasCounterBound(template, cycle)) continue;

      const key = `${node.id}->${branch.goto}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      d.warn(
        'CYCLE_WITHOUT_COUNTER',
        `verdict branch ${node.id} → ${branch.goto} forms an automated cycle with no human gate or counter cap`,
        { nodeId: node.id },
      );
    }
  }
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

function cycleHasCounterBound(template: Template, cycle: Set<string>): boolean {
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
    return node.branches
      .filter(isGuardedBranch)
      .some((branch) => conditionReadsAnyScope(branch.when, incremented));
  });
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

function conditionReadsAnyScope(cond: Condition, scopes: ReadonlySet<string>): boolean {
  switch (cond.op) {
    case 'counter.lt':
    case 'counter.gte':
      return scopes.has(cond.scope);
    case 'all':
    case 'any':
      return cond.of.some((item) => conditionReadsAnyScope(item, scopes));
    case 'not':
      return conditionReadsAnyScope(cond.cond, scopes);
    default:
      return false;
  }
}
