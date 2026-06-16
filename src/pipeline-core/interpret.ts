/**
 * pipeline-core/interpret.ts — the pure deterministic reducer (§10).
 *
 *   step(template, state, lastResult) -> { state, decision }
 *
 * One call advances the run by exactly one OBSERVABLE step. Given the current cursor and the RECORDED
 * result of the previously-emitted Decision, it computes the NEXT cursor (updated/reset scoped
 * counters + activeNodeIds + status) AND the next effect `decision`. Total + deterministic: no clocks,
 * no randomness, no live reads — every external fact arrives as recorded data on `lastResult` (§10).
 *
 * The adapter loop (§10): `{state, decision} = step(t, state, lastResult)` → execute `decision` as a
 * durable step → record its result → feed that back as the next `lastResult` → repeat until
 * `decision.type === 'complete'`.
 *
 * Model. The active node is the one whose Decision was last emitted (or the entry on the first call).
 * `step` first RESOLVES that node against `lastResult` (route a gate/choice by its branches; route an
 * agent/script by its core outcome via §6 precedence; aggregate a join's recorded arrivals), walking
 * through pure routing nodes (`choice`/`join`) until it reaches a node that emits an effect
 * (`agent`/`script`/`humanGate`/`wait`/`parallel`/`terminal`). Loop-entry counter mutations (§7) are
 * applied as each node is entered, BEFORE its guards are evaluated, so a cap-guard sees the
 * post-increment value. Core verdicts route STRUCTURALLY (catch/onFailure/terminal/timeout) and NEVER
 * via branch guards (§3/§6).
 */

import type {
  Condition,
  Decision,
  JoinArrival,
  JoinMode,
  LastResult,
  Node,
  NodeId,
  RunState,
  RunStatus,
  ScopeId,
  Template,
  TerminalStatus,
} from './types.js';

/** Thrown when the interpreter hits a state a VALID template can never produce (a caller/data bug). */
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

/** Kinds that SUSPEND: they emit a Decision and stay active until their result is fed back. */
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

/**
 * Build the initial cursor: the entry node active, every declared scope at 0, no recorded result.
 * The first `step(t, initialState(t), undefined)` emits the entry node's first Decision.
 */
export function initialState(template: Template): RunState {
  const scopedCounters: Record<ScopeId, number> = {};
  for (const scopeId of Object.keys(template.scopes ?? {})) scopedCounters[scopeId] = 0;
  return { activeNodeIds: new Set([template.entry]), scopedCounters, status: 'running' };
}

/**
 * Advance one observable step. Resolves the active node against `lastResult`, walks any pure routing
 * nodes, and returns the next suspending node's Decision plus the next cursor.
 *
 * On the FIRST call (entry just activated, no Decision emitted yet) the active node has not run, so
 * `lastResult` describes nothing for it: we emit its Decision directly. On every later call the active
 * node is a suspended one whose recorded result is in `lastResult`: we route PAST it.
 */
export function step(
  template: Template,
  state: RunState,
  lastResult: LastResult | undefined,
): { state: RunState; decision: Decision } {
  const active = resolveNode(template, soleActiveNodeId(state));

  // First emission of a freshly-entered suspending node: no result to consume yet — emit its Decision.
  if (lastResult === undefined && suspends(active)) {
    return emit(template, active, state);
  }

  // Otherwise consume the active node's recorded result and route onward.
  return routeFrom(template, active, state, lastResult);
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing — consume the active node's result, compute the successor id, then enter it.
// ─────────────────────────────────────────────────────────────────────────────

function routeFrom(
  template: Template,
  node: Node,
  state: RunState,
  lastResult: LastResult | undefined,
): { state: RunState; decision: Decision } {
  switch (node.kind) {
    case 'terminal':
      // A terminal has no successor; re-resolving it just re-asserts completion (idempotent). The
      // cursor SITS on the terminal (activeNodeIds = {terminal}); the adapter detects done via
      // status/decision, not an empty active set.
      return {
        state: { ...state, activeNodeIds: new Set([node.id]), status: STATUS_BY_TERMINAL[node.status] },
        decision: { type: 'complete', status: node.status },
      };

    case 'agent':
    case 'script':
      return routeEffect(template, node, state, lastResult);

    case 'humanGate': {
      // A gate's recorded timeout firing routes via timeout.goto (§6), NOT a branch guard.
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
      const forward = winner?.verdict !== undefined ? { verdict: winner.verdict } : undefined;
      return enter(template, node.next, state, forward);
    }

    case 'parallel':
      // A parallel's "result" is the join's arrivals; routing past a parallel is meaningless —
      // the join consumes the arrivals. Reaching here means the loop mis-fed a result.
      throw new InterpretError(`routeFrom called on parallel ${node.id} (feed the join, not the fork)`);
  }
}

/** §6 failure-precedence routing for an `agent`/`script` node from its RECORDED outcome. */
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

  // Failure (`failed`/`errored`). Precedence: matching catch → onFailure (abort/route/escalate).
  const code = lastResult?.errorCode;
  const matched = code ? node.catch?.find((c) => c.onError === code) : undefined;
  if (matched) return enter(template, matched.goto, state, undefined);

  const policy = node.onFailure ?? 'abort';
  if (policy === 'abort') {
    // The run fails AT the aborting node; the cursor stays on it (no terminal node to route to).
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
  // 'route' with no matching catch — a VALID template forbids this (§6 / §12 FAILURE_ROUTE_NO_CATCH).
  throw new InterpretError(
    `node ${node.id} onFailure=route but no catch matched ${code ?? '<no code>'} (invalid)`,
  );
}

/**
 * ENTER a node: apply its loop-entry counter mutations (§7), make it the sole active node, then
 * either emit its Decision (suspending kinds) or recursively route through it (pure `choice`/`join`).
 * `incoming` is the verdict/arrivals context the entered node's guards may read.
 */
function enter(
  template: Template,
  nodeId: NodeId,
  state: RunState,
  incoming: LastResult | undefined,
): { state: RunState; decision: Decision } {
  const node = resolveNode(template, nodeId);
  const scopedCounters = applyCounterMutations(template, state.scopedCounters, incrementCountersOf(node));
  const entered: RunState = { ...state, scopedCounters, activeNodeIds: new Set([nodeId]) };

  if (suspends(node)) return emit(template, node, entered);
  // Pure routing node — resolve it immediately against the incoming context.
  return routeFrom(template, node, entered, incoming);
}

/** Emit the Decision of a freshly-entered SUSPENDING node and set the matching run status. */
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
      // choice/join never suspend — emit() is only called on suspending kinds.
      throw new InterpretError(`emit() called on non-suspending node ${node.id} (${node.kind})`);
  }
}

function activate(state: RunState, nodeId: NodeId, status: RunStatus): RunState {
  return { ...state, activeNodeIds: new Set([nodeId]), status };
}

/** Forward only a domain verdict (core outcomes are consumed structurally, never carried forward). */
function carryVerdict(lastResult: LastResult | undefined): LastResult | undefined {
  return lastResult?.verdict !== undefined ? { verdict: lastResult.verdict } : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard evaluation (§3) — total, first-true-wins, mandatory default.
// ─────────────────────────────────────────────────────────────────────────────

function evalBranches(
  template: Template,
  nodeId: NodeId,
  branches: { when?: Condition; goto?: NodeId; default?: NodeId }[],
  state: RunState,
  lastResult: LastResult | undefined,
): NodeId {
  let fallback: NodeId | undefined;
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

/**
 * Evaluate a v1 Condition (§3). Reads ONLY the recorded DOMAIN verdict (`lastResult.verdict`) and the
 * scoped counters in `state` — never a core verdict (those route structurally, §3/§6).
 */
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

function counterValue(state: RunState, scope: ScopeId): number {
  return state.scopedCounters[scope] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 Counter mutation — increment + descendant reset, deterministic & pure.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a node's `incrementCounters` to a counter map: +1 each named scope and RESET every
 * descendant scope of each (entering a scope resets its descendants, §7). Returns a fresh map.
 */
export function applyCounterMutations(
  template: Template,
  current: Readonly<Record<ScopeId, number>>,
  increments: readonly ScopeId[],
): Record<ScopeId, number> {
  if (increments.length === 0) return { ...current };
  const next: Record<ScopeId, number> = { ...current };
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

/** True when `candidate`'s ancestor chain (via `parent`) passes through `ancestor`. */
function isDescendantScope(
  scopes: Record<ScopeId, { parent: ScopeId | null }>,
  candidate: ScopeId,
  ancestor: ScopeId,
): boolean {
  let cursor = scopes[candidate]?.parent ?? null;
  const seen = new Set<ScopeId>();
  while (cursor !== null) {
    if (cursor === ancestor) return true;
    if (seen.has(cursor)) break; // defensive against a malformed cycle (validation rejects these)
    seen.add(cursor);
    cursor = scopes[cursor]?.parent ?? null;
  }
  return false;
}

function incrementCountersOf(node: Node): readonly ScopeId[] {
  return 'incrementCounters' in node ? (node.incrementCounters ?? []) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 Join — consume recorded arrivals; pick a deterministic winner.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the join winner from durably-recorded arrivals (§4), in the canonical recorded order
 * (`seq` asc, branchId tie-break):
 *  - `all`    → the barrier; the winner is the last arrival (its verdict is forwarded);
 *  - `any`    → the first arrival;
 *  - `quorum` → the K-th arrival.
 * The core never sees the live race; the adapter supplies the recorded order + cancelled set.
 */
export function selectJoinWinner(
  mode: JoinMode,
  arrivals: readonly JoinArrival[],
  joinId: NodeId,
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
  return ordered[ordered.length - 1]; // 'all'
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function joinModeOf(template: Template, joinId: NodeId): JoinMode {
  const join = resolveNode(template, joinId);
  if (join.kind !== 'join') {
    throw new InterpretError(`fork target ${joinId} is not a join (${join.kind})`);
  }
  return join.joinMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

function resolveNode(template: Template, id: NodeId): Node {
  const node = template.nodes[id];
  if (!node) throw new InterpretError(`unknown node id "${id}" (invalid template)`);
  return node;
}

function soleActiveNodeId(state: RunState): NodeId {
  const ids = [...state.activeNodeIds];
  if (ids.length !== 1) {
    throw new InterpretError(
      `step() expects exactly one active node, got ${ids.length} [${ids.join(', ')}]`,
    );
  }
  return ids[0]!;
}
