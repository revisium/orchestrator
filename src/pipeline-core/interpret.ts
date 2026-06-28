
























import type {
  Condition,
  Decision,
  JoinArrival,
  JoinMode,
  LastResult,
  Node,
  RunState,
  RunStatus,
  Template,
  TerminalStatus,
} from './types.js';


export class InterpretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpretError';
  }
}

const STATUS_BY_TERMINAL: Record<TerminalStatus, RunStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  blocked: 'blocked',
};


function suspends(node: Node): boolean {
  return (
    node.kind === 'agent' ||
    node.kind === 'script' ||
    node.kind === 'humanGate' ||
    node.kind === 'wait' ||
    node.kind === 'parallel' ||
    node.kind === 'terminal'
  );
}



export function initialState(template: Template): RunState {
  const scopedCounters: Record<string, number> = {};
  for (const scopeId of Object.keys(template.scopes ?? {})) scopedCounters[scopeId] = 0;
  return { activeNodeIds: new Set([template.entry]), scopedCounters, status: 'running' };
}







export function step(
  template: Template,
  state: RunState,
  lastResult: LastResult | undefined,
): { state: RunState; decision: Decision } {
  const active = resolveNode(template, soleActiveNodeId(state));

  if (lastResult === undefined && suspends(active)) {
    return emit(template, active, state);
  }

  return routeFrom(template, active, state, lastResult);
}


function routeFrom(
  template: Template,
  node: Node,
  state: RunState,
  lastResult: LastResult | undefined,
): { state: RunState; decision: Decision } {
  switch (node.kind) {
    case 'terminal':
      return {
        state: { ...state, activeNodeIds: new Set([node.id]), status: STATUS_BY_TERMINAL[node.status] },
        decision: { type: 'complete', status: node.status },
      };

    case 'agent':
    case 'script':
      return routeEffect(template, node, state, lastResult);

    case 'humanGate': {
      if (lastResult?.outcome === 'timed_out') {
        if (!node.timeout) {
          throw new InterpretError(`gate ${node.id} timed_out but has no timeout edge (invalid)`);
        }
        return enter(template, node.timeout.goto, state, undefined);
      }
      const goto = evalBranches(template, node.id, node.branches, state, lastResult);
      return enter(template, goto, state, carryVerdict(lastResult));
    }

    case 'choice': {
      const goto = evalBranches(template, node.id, node.branches, state, lastResult);
      return enter(template, goto, state, carryVerdict(lastResult));
    }

    case 'wait':
      return enter(template, node.next, state, undefined);

    case 'join': {
      const arrivals = lastResult?.joinArrivals ?? [];
      const winner = selectJoinWinner(node.joinMode, arrivals, node.id);
      const forward = winner?.verdict === undefined ? undefined : { verdict: winner.verdict };
      return enter(template, node.next, state, forward);
    }

    case 'parallel':
      throw new InterpretError(`routeFrom called on parallel ${node.id} (feed the join, not the fork)`);
  }
}


function routeEffect(
  template: Template,
  node: Extract<Node, { kind: 'agent' | 'script' }>,
  state: RunState,
  lastResult: LastResult | undefined,
): { state: RunState; decision: Decision } {
  const outcome = lastResult?.outcome;

  if (outcome === undefined || outcome === 'succeeded') {
    return enter(template, node.next, state, carryVerdict(lastResult));
  }

  const code = lastResult?.errorCode;
  const matched = code ? node.catch?.find((c) => c.onError === code) : undefined;
  if (matched) return enter(template, matched.goto, state, undefined);

  const policy = node.onFailure ?? 'abort';
  if (policy === 'abort') {
    return {
      state: { ...state, activeNodeIds: new Set([node.id]), status: 'failed' },
      decision: { type: 'complete', status: 'failed' },
    };
  }
  if (policy === 'escalate') {
    if (!node.escalateTo) {
      throw new InterpretError(`node ${node.id} onFailure=escalate but escalateTo missing (invalid)`);
    }
    return enter(template, node.escalateTo, state, undefined);
  }
  throw new InterpretError(
    `node ${node.id} onFailure=route but no catch matched ${code ?? '<no code>'} (invalid)`,
  );
}




function enter(
  template: Template,
  nodeId: string,
  state: RunState,
  incoming: LastResult | undefined,
): { state: RunState; decision: Decision } {
  const node = resolveNode(template, nodeId);
  const scopedCounters = applyCounterMutations(template, state.scopedCounters, incrementCountersOf(node));
  const entered: RunState = { ...state, scopedCounters, activeNodeIds: new Set([nodeId]) };

  if (suspends(node)) return emit(template, node, entered);
  return routeFrom(template, node, entered, incoming);
}


function emit(
  template: Template,
  node: Node,
  state: RunState,
): { state: RunState; decision: Decision } {
  switch (node.kind) {
    case 'agent':
      return {
        state: activate(state, node.id, 'running'),
        decision: { type: 'invokeRole', nodeId: node.id, roleRef: node.roleRef, input: {} },
      };
    case 'script':
      return {
        state: activate(state, node.id, 'running'),
        decision: { type: 'invokeScript', nodeId: node.id, scriptRef: node.scriptRef, input: {} },
      };
    case 'humanGate':
      return {
        state: activate(state, node.id, 'awaiting_gate'),
        decision: {
          type: 'awaitGate',
          nodeId: node.id,
          reason: node.reason,
          outcomes: node.outcomes,
          ...(node.timeout ? { timeout: node.timeout } : {}),
          ...(node.gatedArtifact ? { gatedArtifact: node.gatedArtifact } : {}),
          ...(node.verdictFrom ? { verdictFrom: node.verdictFrom } : {}),
        },
      };
    case 'wait':
      return {
        state: activate(state, node.id, 'running'),
        decision: { type: 'startTimer', nodeId: node.id, duration: node.duration },
      };
    case 'parallel':
      return {
        state: { ...state, activeNodeIds: new Set(node.branches.map((b) => b.entry)), status: 'running' },
        decision: {
          type: 'fork',
          nodeId: node.id,
          branches: node.branches,
          joinId: node.join,
          mode: joinModeOf(template, node.join),
        },
      };
    case 'terminal':
      return {
        state: { ...state, activeNodeIds: new Set([node.id]), status: STATUS_BY_TERMINAL[node.status] },
        decision: { type: 'complete', status: node.status },
      };
    default:
      throw new InterpretError(`emit() called on non-suspending node ${node.id} (${node.kind})`);
  }
}

function activate(state: RunState, nodeId: string, status: RunStatus): RunState {
  return { ...state, activeNodeIds: new Set([nodeId]), status };
}


function carryVerdict(lastResult: LastResult | undefined): LastResult | undefined {
  return lastResult?.verdict === undefined ? undefined : { verdict: lastResult.verdict };
}


function evalBranches(
  template: Template,
  nodeId: string,
  branches: { when?: Condition; goto?: string; default?: string }[],
  state: RunState,
  lastResult: LastResult | undefined,
): string {
  let fallback: string | undefined;
  for (const b of branches) {
    if (b.default !== undefined) {
      fallback = b.default;
      continue;
    }
    if (b.when && b.goto !== undefined && evalCondition(b.when, state, lastResult)) return b.goto;
  }
  if (fallback === undefined) {
    throw new InterpretError(`node ${nodeId} has no default branch (invalid template)`);
  }
  return fallback;
}



export function evalCondition(
  cond: Condition,
  state: RunState,
  lastResult: LastResult | undefined,
): boolean {
  switch (cond.op) {
    case 'verdict.eq':
      return lastResult?.verdict === cond.value;
    case 'verdict.in':
      return lastResult?.verdict !== undefined && cond.value.includes(lastResult.verdict);
    case 'counter.lt':
      return counterValue(state, cond.scope) < cond.value;
    case 'counter.gte':
      return counterValue(state, cond.scope) >= cond.value;
    case 'all':
      return cond.of.every((c) => evalCondition(c, state, lastResult));
    case 'any':
      return cond.of.some((c) => evalCondition(c, state, lastResult));
    case 'not':
      return !evalCondition(cond.cond, state, lastResult);
  }
}

function counterValue(state: RunState, scope: string): number {
  return state.scopedCounters[scope] ?? 0;
}




export function applyCounterMutations(
  template: Template,
  current: Readonly<Record<string, number>>,
  increments: readonly string[],
): Record<string, number> {
  if (increments.length === 0) return { ...current };
  const next: Record<string, number> = { ...current };
  const scopes = template.scopes ?? {};
  for (const scopeId of increments) {
    next[scopeId] = (next[scopeId] ?? 0) + 1;
    for (const descendant of Object.keys(scopes)) {
      if (descendant !== scopeId && isDescendantScope(scopes, descendant, scopeId)) {
        next[descendant] = 0;
      }
    }
  }
  return next;
}


function isDescendantScope(
  scopes: Record<string, { parent: string | null }>,
  candidate: string,
  ancestor: string,
): boolean {
  let cursor = scopes[candidate]?.parent ?? null;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === ancestor) return true;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = scopes[cursor]?.parent ?? null;
  }
  return false;
}

function incrementCountersOf(node: Node): readonly string[] {
  return 'incrementCounters' in node ? (node.incrementCounters ?? []) : [];
}








export function selectJoinWinner(
  mode: JoinMode,
  arrivals: readonly JoinArrival[],
  joinId: string,
): JoinArrival | undefined {
  const ordered = [...arrivals].sort((a, b) => a.seq - b.seq || cmp(a.branchId, b.branchId));
  if (mode.kind === 'any') return ordered[0];
  if (mode.kind === 'quorum') {
    if (ordered.length < mode.count) {
      throw new InterpretError(
        `join ${joinId} quorum needs ${mode.count}, has ${ordered.length} recorded arrivals`,
      );
    }
    return ordered[mode.count - 1];
  }
  return ordered.at(-1);
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function joinModeOf(template: Template, joinId: string): JoinMode {
  const join = resolveNode(template, joinId);
  if (join.kind !== 'join') {
    throw new InterpretError(`fork target ${joinId} is not a join (${join.kind})`);
  }
  return join.joinMode;
}


function resolveNode(template: Template, id: string): Node {
  const node = template.nodes[id];
  if (!node) throw new InterpretError(`unknown node id "${id}" (invalid template)`);
  return node;
}

function soleActiveNodeId(state: RunState): string {
  const ids = [...state.activeNodeIds];
  if (ids.length !== 1) {
    throw new InterpretError(
      `step() expects exactly one active node, got ${ids.length} [${ids.join(', ')}]`,
    );
  }
  return ids[0];
}
