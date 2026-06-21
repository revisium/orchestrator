/**
 * pipeline-core/validate.ts — the authoritative install-time validator (§12). Runs rules 1–12 + 14
 * (each imported from its sibling module) and re-exports the diff classifier (rule 13) from
 * validate-diff.ts, so the public surface (`validateTemplate`, `classifyTemplateDiff`) is unchanged.
 *
 * Pure: zero I/O, no clocks. Each §12 rule is its own collector; `validateTemplate` runs them all and
 * returns every finding (it does not stop at the first error). Codes are stable (tested against).
 */

import {
  CORE_VERDICTS,
  CONDITION_OPS,
  FAILURE_POLICIES,
  MERGE_REDUCERS,
  TERMINAL_STATUSES,
  isDefaultBranch,
  isGuardedBranch,
  isRevoErrorCode,
} from './types.js';
import type { Condition, Diagnostic, Node, Scope, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { outgoingEdges } from './validate-edges.js';
import { ruleConflictMatrix } from './validate-conflicts.js';
import { ruleCapabilityRefs } from './validate-capability.js';

export { classifyTemplateDiff } from './validate-diff.js';
export type { DiffKind, TemplateDiff } from './validate-diff.js';

const NODE_ID_PATTERN = /^[A-Za-z]\w*$/;

// ─────────────────────────────────────────────────────────────────────────────
// Public entry.
// ─────────────────────────────────────────────────────────────────────────────

/** Run all §12 rules (1–12). Returns every diagnostic; empty ⇒ the template is valid. */
export function validateTemplate(template: Template): Diagnostic[] {
  const d = new DiagSink();
  const nodes = template.nodes ?? {};
  const ids = new Set(Object.keys(nodes));

  ruleIdHygiene(template, d); // run first — duplicate/bad ids inform the rest
  ruleSingleEntry(template, ids, d);
  ruleReferencesResolve(template, ids, d);
  ruleTerminals(template, d);
  ruleConditionGrammar(template, d); // grammar sanity — feeds rules 2/4/9
  ruleTotalRouting(template, d);
  ruleReachability(template, ids, d);
  ruleFailurePolicy(template, d); // failure-policy well-formedness
  ruleLoopCap(template, d); // loop-cap presence
  ruleCounterScopes(template, d);
  ruleParallelJoin(template, d);
  ruleVerdictClosure(template, d);
  ruleConflictMatrix(template, d);
  ruleCapabilityRefs(template, d);
  ruleDataflow(template, ids, d); // produces/consumes — 0016 §7

  return d.items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 11 — id/namespace hygiene.
// ─────────────────────────────────────────────────────────────────────────────

function ruleIdHygiene(template: Template, d: DiagSink): void {
  const seen = new Set<string>();
  for (const [key, node] of Object.entries(template.nodes ?? {})) {
    checkNodeKeyHygiene(key, node, seen, d);
    seen.add(key);
  }
  checkCatchCodeVerdictCollisions(template, d);
}

/** One node entry's id hygiene: map-key/node-id mismatch, id pattern, and duplicate-key detection. */
function checkNodeKeyHygiene(key: string, node: Node | undefined, seen: Set<string>, d: DiagSink): void {
  // The map key is the canonical id; a node carrying a mismatching `id` is a hygiene defect too.
  if (node?.id !== undefined && node.id !== key) {
    d.error('ID_BAD_PATTERN', `node "${key}" has mismatching id "${node.id}"`, { nodeId: key });
  }
  if (!NODE_ID_PATTERN.test(key)) {
    d.error('ID_BAD_PATTERN', `node id "${key}" does not match ${NODE_ID_PATTERN}`, { nodeId: key });
  }
  if (seen.has(key)) d.error('ID_DUPLICATE', `duplicate node id "${key}"`, { nodeId: key });
}

/** revo.* error codes must never collide with a declared verdict label (disjoint namespaces, §3/§6). */
function checkCatchCodeVerdictCollisions(template: Template, d: DiagSink): void {
  const domain = new Set(template.verdicts?.domain ?? []);
  for (const node of Object.values(template.nodes ?? {})) {
    if (node?.kind !== 'agent' && node?.kind !== 'script') continue;
    for (const c of node.catch ?? []) {
      if (domain.has(c.onError)) {
        d.error('REVO_CODE_COLLIDES_VERDICT', `catch code "${c.onError}" collides with a verdict label`, {
          nodeId: node.id,
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — single entry.
// ─────────────────────────────────────────────────────────────────────────────

function ruleSingleEntry(template: Template, ids: Set<string>, d: DiagSink): void {
  if (!template.entry) {
    d.error('ENTRY_MISSING', 'template has no `entry`');
    return;
  }
  if (!ids.has(template.entry)) {
    d.error('ENTRY_UNRESOLVED', `entry "${template.entry}" does not resolve to a node`, {
      nodeId: template.entry,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2 — references resolve (every edge target exists).
// ─────────────────────────────────────────────────────────────────────────────

function ruleReferencesResolve(template: Template, ids: Set<string>, d: DiagSink): void {
  const check = (target: string | undefined, node: Node, path: string): void => {
    if (target === undefined) return;
    if (!ids.has(target)) {
      d.error('REF_UNRESOLVED', `${node.id}.${path} → unknown node "${target}"`, { nodeId: node.id, path });
    }
  };
  for (const node of Object.values(template.nodes)) {
    for (const [path, target] of outgoingEdges(node)) check(target, node, path);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 — terminals & non-terminals.
// ─────────────────────────────────────────────────────────────────────────────

function ruleTerminals(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'terminal') {
      if (!TERMINAL_STATUSES.includes(node.status)) {
        d.error('TERMINAL_BAD_STATUS', `terminal ${node.id} has bad status "${node.status}"`, {
          nodeId: node.id,
        });
      }
      // The discriminated union forbids exit fields on a terminal at the type level; nothing else to check.
    } else if (outgoingEdges(node).length === 0) {
      d.error('NONTERMINAL_NO_EXIT', `non-terminal ${node.id} (${node.kind}) has no exit edge`, {
        nodeId: node.id,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Condition grammar sanity — a malformed guard can't be evaluated (feeds rules 2/4/9).
// ─────────────────────────────────────────────────────────────────────────────

function ruleConditionGrammar(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    for (const cond of guardConditionsOf(node)) checkCondition(cond, node.id, d);
  }
}

function checkCondition(cond: Condition, nodeId: string, d: DiagSink): void {
  const op = (cond as { op?: unknown }).op;
  if (typeof op !== 'string' || !CONDITION_OPS.includes(op as (typeof CONDITION_OPS)[number])) {
    d.error('CONDITION_BAD_OP', `node ${nodeId} guard has unknown op "${String(op)}"`, { nodeId });
    return;
  }
  switch (cond.op) {
    case 'verdict.eq':
      if (typeof cond.value !== 'string') d.error('CONDITION_BAD_SHAPE', `verdict.eq value must be a string`, { nodeId });
      break;
    case 'verdict.in':
      if (!Array.isArray(cond.value) || cond.value.some((v) => typeof v !== 'string')) {
        d.error('CONDITION_BAD_SHAPE', `verdict.in value must be a string[]`, { nodeId });
      }
      break;
    case 'counter.lt':
    case 'counter.gte':
      if (typeof cond.scope !== 'string' || !Number.isInteger(cond.value)) {
        d.error('CONDITION_BAD_SHAPE', `${cond.op} needs a scope + integer value`, { nodeId });
      }
      break;
    case 'all':
    case 'any':
      if (Array.isArray(cond.of)) cond.of.forEach((c) => checkCondition(c, nodeId, d));
      else d.error('CONDITION_BAD_SHAPE', `${cond.op} needs an "of" array`, { nodeId });
      break;
    case 'not':
      if (cond.cond) checkCondition(cond.cond, nodeId, d);
      else d.error('CONDITION_BAD_SHAPE', `not needs a "cond"`, { nodeId });
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4 — total routing (default present; no guard after default; one default).
// ─────────────────────────────────────────────────────────────────────────────

function ruleTotalRouting(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind !== 'choice' && node.kind !== 'humanGate') continue;
    const branches = node.branches;
    const defaultIdxs = branches.map((b, i) => (isDefaultBranch(b) ? i : -1)).filter((i) => i >= 0);
    if (defaultIdxs.length === 0) {
      d.error('ROUTING_NO_DEFAULT', `${node.kind} ${node.id} has no trailing default branch`, {
        nodeId: node.id,
      });
      continue;
    }
    if (defaultIdxs.length > 1) {
      d.error('ROUTING_MULTIPLE_DEFAULT', `${node.kind} ${node.id} has ${defaultIdxs.length} defaults`, {
        nodeId: node.id,
      });
    }
    const firstDefault = defaultIdxs[0];
    if (firstDefault !== branches.length - 1) {
      d.error('ROUTING_GUARD_AFTER_DEFAULT', `${node.kind} ${node.id} has a guard after its default`, {
        nodeId: node.id,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 5 — reachability (every node reachable from entry; no dead nodes).
// ─────────────────────────────────────────────────────────────────────────────

function ruleReachability(template: Template, ids: Set<string>, d: DiagSink): void {
  if (!template.entry || !ids.has(template.entry)) return; // rule 1 already flagged it
  const reachable = reachableFrom(template, template.entry);
  for (const id of ids) {
    if (!reachable.has(id)) d.error('UNREACHABLE_NODE', `node "${id}" is unreachable from entry`, { nodeId: id });
  }
}

function reachableFrom(template: Template, entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = template.nodes[id];
    if (!node) continue;
    for (const [, target] of outgoingEdges(node)) if (!seen.has(target)) stack.push(target);
  }
  return seen;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6a — per-node failure policy well-formedness.
// ─────────────────────────────────────────────────────────────────────────────

function ruleFailurePolicy(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent' || node.kind === 'script') checkNodeFailurePolicy(node, d);
  }
}

/** Per effect-node §6 failure-policy well-formedness: known policy, valid catch codes, route/escalate. */
function checkNodeFailurePolicy(node: Extract<Node, { kind: 'agent' | 'script' }>, d: DiagSink): void {
  const policy = node.onFailure ?? 'abort';
  if (!FAILURE_POLICIES.includes(policy)) {
    d.error('CATCH_BAD_CODE', `node ${node.id} has unknown onFailure "${policy}"`, { nodeId: node.id });
  }
  for (const c of node.catch ?? []) {
    if (typeof c.onError !== 'string' || !isRevoErrorCode(c.onError)) {
      d.error('CATCH_BAD_CODE', `node ${node.id} catch onError "${c.onError}" is not a revo.* code`, {
        nodeId: node.id,
      });
    }
  }
  if (policy === 'route' && (node.catch ?? []).length === 0) {
    d.error('FAILURE_ROUTE_NO_CATCH', `node ${node.id} onFailure=route requires a catch`, {
      nodeId: node.id,
    });
  }
  if (policy === 'escalate' && node.escalateTo === undefined) {
    d.error('FAILURE_ESCALATE_NO_TARGET', `node ${node.id} onFailure=escalate requires escalateTo`, {
      nodeId: node.id,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6b — loop-cap presence.
//
// Spec note (two ambiguities resolved against the canonical §13 example, which §13 declares
// internally-consistent and the task names as THE fixture):
//  1. §12.6 says "a terminating cap-guard (counter.gte)", but §13 expresses the SAME bound as
//     `counter.lt K` on the CONTINUE edge with the default routing OUT (once the counter reaches K the
//     guard fails and control falls through to blockedEnd). Both make the loop finite, so we accept
//     EITHER: a cycle is counter-bounded iff some `choice` on it has a guard referencing a `counter.*`
//     over a scope INCREMENTED on the cycle.
//  2. §13's analyst↔planGate `changes_requested` loop carries NO counter — it is bounded only by human
//     judgment. §6 makes a human-driven loop legitimately unbounded ("durable wait is free … for
//     human-driven runs"). So a cycle that passes through a `humanGate` is also accepted.
// An AUTOMATED loop (agents/scripts/choices only) with no counter is rejected (LOOP_UNBOUNDED).
// ─────────────────────────────────────────────────────────────────────────────

function ruleLoopCap(template: Template, d: DiagSink): void {
  if (!template.entry || !template.nodes[template.entry]) return;
  for (const { from, to } of findBackEdges(template)) {
    const cycle = cycleNodes(template, to, from);
    const incrementedOnCycle = scopesIncrementedOnCycle(template, cycle);
    const counterBounded = [...cycle].some((id) => choiceGatesCycleByCounter(template, id, incrementedOnCycle));
    const humanDriven = [...cycle].some((id) => template.nodes[id]?.kind === 'humanGate');
    if (!counterBounded && !humanDriven) {
      d.error('LOOP_UNBOUNDED', `back-edge ${from} → ${to} is not bounded by a counter cap-guard or a human gate`, {
        nodeId: from,
      });
    }
  }
}

/** Scope ids incremented by any node on the cycle (the loop's bound must count one of these). */
function scopesIncrementedOnCycle(template: Template, cycle: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of cycle) {
    const node = template.nodes[id];
    if (node && 'incrementCounters' in node) for (const s of node.incrementCounters ?? []) out.add(s);
  }
  return out;
}

/** A choice with a guard that references a `counter.*` over a scope incremented on the cycle. */
function choiceGatesCycleByCounter(template: Template, id: string, incrementedOnCycle: Set<string>): boolean {
  const node = template.nodes[id];
  if (node?.kind !== 'choice') return false;
  return node.branches.filter(isGuardedBranch).some((b) => conditionGatesOnScopes(b.when, incrementedOnCycle));
}

/** True when `cond` compares a `counter.*` against one of `scopes`. */
function conditionGatesOnScopes(cond: Condition, scopes: Set<string>): boolean {
  switch (cond.op) {
    case 'counter.lt':
    case 'counter.gte':
      return scopes.has(cond.scope);
    case 'all':
    case 'any':
      return cond.of.some((c) => conditionGatesOnScopes(c, scopes));
    case 'not':
      return conditionGatesOnScopes(cond.cond, scopes);
    default:
      return false;
  }
}

/** Back-edges = forward edges whose target is an ancestor on the DFS stack (a cycle re-entry). */
function findBackEdges(template: Template): Array<{ from: string; to: string }> {
  const back: Array<{ from: string; to: string }> = [];
  const onStack = new Set<string>();
  const done = new Set<string>();
  const dfs = (id: string): void => {
    onStack.add(id);
    const node = template.nodes[id];
    if (node) {
      for (const [, target] of structuralEdges(node)) {
        if (onStack.has(target)) back.push({ from: id, to: target });
        else if (!done.has(target)) dfs(target);
      }
    }
    onStack.delete(id);
    done.add(id);
  };
  if (template.entry && template.nodes[template.entry]) dfs(template.entry);
  return back;
}

/** Forward (non-catch, non-escalate) edges — `catch`/`escalateTo` are failure routes, not loop edges. */
function structuralEdges(node: Node): Array<[string, string]> {
  return outgoingEdges(node).filter(([p]) => !p.startsWith('catch') && p !== 'escalateTo');
}

/** Nodes on a cycle that re-enters `to` via the back-edge from `from` (path to→…→from + from). */
function cycleNodes(template: Template, to: string, from: string): Set<string> {
  // Forward-reachable from `to` (staying inside the SCC reaching `from`) — a simple over-approx is the
  // set of nodes on some path to→…→from. We collect nodes that can both reach `from` and are reached
  // from `to`, which is exactly the cycle's SCC member set for these structural edges.
  const fromTo = forwardReach(template, to);
  const canReachFrom = backwardReach(template, from);
  const cycle = new Set<string>();
  for (const id of fromTo) if (canReachFrom.has(id)) cycle.add(id);
  cycle.add(to);
  cycle.add(from);
  return cycle;
}

function forwardReach(template: Template, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = template.nodes[id];
    if (node) for (const [, t] of structuralEdges(node)) if (!seen.has(t)) stack.push(t);
  }
  return seen;
}

function backwardReach(template: Template, target: string): Set<string> {
  const preds = new Map<string, string[]>();
  for (const node of Object.values(template.nodes)) {
    for (const [, t] of structuralEdges(node)) (preds.get(t) ?? preds.set(t, []).get(t)!).push(node.id);
  }
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of preds.get(id) ?? []) if (!seen.has(p)) stack.push(p);
  }
  return seen;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 7 — counter-scope well-formedness.
// ─────────────────────────────────────────────────────────────────────────────

function ruleCounterScopes(template: Template, d: DiagSink): void {
  const scopes = template.scopes ?? {};
  const scopeIds = new Set(Object.keys(scopes));

  checkScopeParentsAndCycles(scopes, scopeIds, d); //          7a parents resolve + no cycle
  checkScopesDeclared(template, scopeIds, d); //               7b every referenced scope is declared
  for (const scopeId of scopeIds) checkScopeStrictAncestry(template, scopeId, d); // 7c reset = strict ancestor
  for (const scopeId of Object.keys(scopes)) checkScopeDoesNotSpanParallel(template, scopeId, d); // 7d no parallel/join
}

/** 7a — every scope's parent resolves to a declared scope and the parent chain has no cycle. */
function checkScopeParentsAndCycles(
  scopes: Record<string, Scope>,
  scopeIds: Set<string>,
  d: DiagSink,
): void {
  for (const [scopeId, scope] of Object.entries(scopes)) {
    if (scope.parent !== null && !scopeIds.has(scope.parent)) {
      d.error('SCOPE_PARENT_UNRESOLVED', `scope "${scopeId}" parent "${scope.parent}" is not declared`, {
        scope: scopeId,
      });
    }
  }
  for (const scopeId of scopeIds) {
    if (scopeChainHasCycle(scopes, scopeId)) {
      d.error('SCOPE_CYCLE', `scope "${scopeId}" has a parent cycle`, { scope: scopeId });
    }
  }
}

/** 7b — every scope referenced by a node (increment or guard) is declared. */
function checkScopesDeclared(template: Template, scopeIds: Set<string>, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    for (const scopeRef of referencedScopes(node)) {
      if (!scopeIds.has(scopeRef)) {
        d.error('SCOPE_UNDECLARED', `node ${node.id} references undeclared scope "${scopeRef}"`, {
          nodeId: node.id,
          scope: scopeRef,
        });
      }
    }
  }
}

/**
 * 7c — a reset scope is a STRICT ancestor of every node that reads/increments it (§7/§12.7). The scope's
 * region is its loop sub-graph: the node(s) that increment it + the guard node(s) that read it. A
 * well-formed reader sits inside that loop — i.e. it shares a cycle with an increment site, or is
 * forward-reachable from one (the cap-guard reads after a rework hop). A reader disconnected from
 * every increment site is a cross-scope/out-of-scope reference; a scope read but never incremented
 * can never advance (its cap is dead). Both are SCOPE_NOT_STRICT_ANCESTOR.
 */
function checkScopeStrictAncestry(template: Template, scopeId: string, d: DiagSink): void {
  const incrementSites = nodesIncrementing(template, scopeId);
  const readers = nodesReadingScope(template, scopeId);
  if (incrementSites.length === 0 && readers.length > 0) {
    for (const r of readers) {
      d.error('SCOPE_NOT_STRICT_ANCESTOR', `scope "${scopeId}" is read by ${r} but never incremented`, {
        nodeId: r,
        scope: scopeId,
      });
    }
    return;
  }
  for (const reader of readers) {
    const insideLoop = incrementSites.some(
      (site) => sharesCycle(template, site, reader) || forwardReach(template, site).has(reader),
    );
    if (!insideLoop) {
      d.error('SCOPE_NOT_STRICT_ANCESTOR', `scope "${scopeId}" reader ${reader} is outside its loop region`, {
        nodeId: reader,
        scope: scopeId,
      });
    }
  }
}

/** 7d — a counter scope may not span a parallel/join boundary (v1). */
function checkScopeDoesNotSpanParallel(template: Template, scopeId: string, d: DiagSink): void {
  const region = new Set<string>([...nodesIncrementing(template, scopeId), ...nodesReadingScope(template, scopeId)]);
  for (const id of region) {
    const node = template.nodes[id];
    if (node && (node.kind === 'parallel' || node.kind === 'join')) {
      d.error('SCOPE_SPANS_PARALLEL', `scope "${scopeId}" spans a ${node.kind} boundary (${id})`, {
        nodeId: id,
        scope: scopeId,
      });
    }
  }
}

function scopeChainHasCycle(scopes: Record<string, { parent: string | null }>, start: string): boolean {
  let cursor: string | null = scopes[start]?.parent ?? null;
  const seen = new Set<string>([start]);
  while (cursor !== null) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = scopes[cursor]?.parent ?? null;
  }
  return false;
}

function referencedScopes(node: Node): string[] {
  const out: string[] = [];
  if ('incrementCounters' in node && node.incrementCounters) out.push(...node.incrementCounters);
  for (const cond of guardConditionsOf(node)) collectCounterScopes(cond, out);
  return out;
}

function collectCounterScopes(cond: Condition, out: string[]): void {
  switch (cond.op) {
    case 'counter.lt':
    case 'counter.gte':
      out.push(cond.scope);
      break;
    case 'all':
    case 'any':
      cond.of.forEach((c) => collectCounterScopes(c, out));
      break;
    case 'not':
      collectCounterScopes(cond.cond, out);
      break;
  }
}

function nodesIncrementing(template: Template, scopeId: string): string[] {
  return Object.values(template.nodes)
    .filter((n) => 'incrementCounters' in n && (n.incrementCounters ?? []).includes(scopeId))
    .map((n) => n.id);
}

function nodesReadingScope(template: Template, scopeId: string): string[] {
  const out: string[] = [];
  for (const node of Object.values(template.nodes)) {
    for (const cond of guardConditionsOf(node)) {
      const scopes: string[] = [];
      collectCounterScopes(cond, scopes);
      if (scopes.includes(scopeId)) {
        out.push(node.id);
        break;
      }
    }
  }
  return out;
}

function sharesCycle(template: Template, a: string, b: string): boolean {
  return forwardReach(template, a).has(b) && forwardReach(template, b).has(a);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 8 — parallel/join well-formedness.
// ─────────────────────────────────────────────────────────────────────────────

function ruleParallelJoin(template: Template, d: DiagSink): void {
  const nodes = template.nodes;
  const parallels = Object.values(nodes).filter((n): n is Extract<Node, { kind: 'parallel' }> => n.kind === 'parallel');
  const joinUsedBy = new Map<string, string[]>();

  for (const par of parallels) checkParallelAgainstJoin(template, par, joinUsedBy, d);

  for (const [joinId, owners] of joinUsedBy) {
    if (owners.length > 1) {
      d.error('JOIN_MULTIPLE_PARALLELS', `join "${joinId}" is the target of ${owners.length} parallels`, {
        nodeId: joinId,
      });
    }
  }
}

/** Validate one parallel against its declared join (resolution, kind, quorum, membership, merge). */
function checkParallelAgainstJoin(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  joinUsedBy: Map<string, string[]>,
  d: DiagSink,
): void {
  const join = template.nodes[par.join];
  if (!join) {
    d.error('PARALLEL_JOIN_UNRESOLVED', `parallel ${par.id} join "${par.join}" does not resolve`, { nodeId: par.id });
    return;
  }
  if (join.kind !== 'join') {
    d.error('PARALLEL_JOIN_KIND', `parallel ${par.id} join "${par.join}" is a ${join.kind}, not a join`, {
      nodeId: par.id,
    });
    return;
  }
  (joinUsedBy.get(par.join) ?? joinUsedBy.set(par.join, []).get(par.join)!).push(par.id);

  checkQuorumBound(par, join, d);
  // Branch membership + cross-branch goto + all-reachability.
  checkBranchMembership(template, par, join.id, d);
  // Multi-writer fields need a merge reducer.
  checkMergeReducers(template, par, join, d);
  checkRejectedMergeReducers(join, d);
}

/** Quorum K must satisfy 1 ≤ K ≤ N (branch count). */
function checkQuorumBound(
  par: Extract<Node, { kind: 'parallel' }>,
  join: Extract<Node, { kind: 'join' }>,
  d: DiagSink,
): void {
  if (join.joinMode.kind !== 'quorum') return;
  const K = join.joinMode.count;
  if (!Number.isInteger(K) || K < 1 || K > par.branches.length) {
    d.error('QUORUM_K_GT_N', `join ${join.id} quorum K=${K} but parallel has ${par.branches.length} branches`, {
      nodeId: join.id,
    });
  }
}

/** Reject any merge reducer outside the allowed set (defensive; the type forbids it but data may carry it). */
function checkRejectedMergeReducers(join: Extract<Node, { kind: 'join' }>, d: DiagSink): void {
  for (const [field, reducer] of Object.entries(join.merge ?? {})) {
    if (!MERGE_REDUCERS.includes(reducer)) {
      d.error('MERGE_LASTWRITE_REJECTED', `join ${join.id} merge.${field} = "${reducer}" is not allowed`, {
        nodeId: join.id,
        path: `merge.${field}`,
      });
    }
  }
}

function checkBranchMembership(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  joinId: string,
  d: DiagSink,
): void {
  const memberOf = buildBranchMembership(template, par, joinId, d);
  checkCrossBranchGotos(template, memberOf, joinId, d);
}

/**
 * Assign each branch sub-graph node to its owning branch (flagging shared membership) and, for an
 * `all` join, flag any branch that cannot reach the join. Returns the node→branch ownership map.
 */
function buildBranchMembership(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  joinId: string,
  d: DiagSink,
): Map<string, string> {
  const memberOf = new Map<string, string>();
  for (const branch of par.branches) {
    for (const m of branchSubgraph(template, branch.entry, joinId)) {
      if (memberOf.has(m) && memberOf.get(m) !== branch.id) {
        d.error('BRANCH_MEMBERSHIP', `node ${m} is a member of branches "${memberOf.get(m)}" and "${branch.id}"`, {
          nodeId: m,
        });
      }
      memberOf.set(m, branch.id);
    }
    checkAllJoinReachable(template, branch, joinId, d);
  }
  return memberOf;
}

/** all-reachability: an `all`-join branch must be able to reach the join (no deadlock). */
function checkAllJoinReachable(
  template: Template,
  branch: { id: string; entry: string },
  joinId: string,
  d: DiagSink,
): void {
  const join = template.nodes[joinId];
  if (join?.kind !== 'join' || join.joinMode.kind !== 'all') return;
  if (!forwardReach(template, branch.entry).has(joinId)) {
    d.error('JOIN_UNREACHABLE_BRANCH', `branch "${branch.id}" (all) cannot reach join ${joinId}`, {
      nodeId: branch.entry,
    });
  }
}

/** Cross-branch goto: a branch member may only goto within its own branch sub-graph or to the join. */
function checkCrossBranchGotos(
  template: Template,
  memberOf: Map<string, string>,
  joinId: string,
  d: DiagSink,
): void {
  for (const [member, branchId] of memberOf) {
    const node = template.nodes[member];
    if (!node) continue;
    for (const [path, target] of structuralEdges(node)) {
      if (target === joinId) continue;
      const targetBranch = memberOf.get(target);
      if (targetBranch !== undefined && targetBranch !== branchId) {
        d.error('BRANCH_CROSS_GOTO', `node ${member} (branch ${branchId}) goto ${target} crosses into branch ${targetBranch}`, {
          nodeId: member,
          path,
        });
      }
    }
  }
}

/** Nodes reachable from a branch `entry`, stopping AT the join (the join itself is not a member). */
function branchSubgraph(template: Template, entry: string, joinId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === joinId || seen.has(id)) continue;
    seen.add(id);
    const node = template.nodes[id];
    if (node) for (const [, t] of structuralEdges(node)) if (t !== joinId && !seen.has(t)) stack.push(t);
  }
  return seen;
}

function checkMergeReducers(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  join: Extract<Node, { kind: 'join' }>,
  d: DiagSink,
): void {
  // v1 cannot statically know a node's written fields without a resultSchema model, so we use a
  // conservative proxy: a parallel fanning out ≥2 effect (agent/script) branches writes results from
  // >1 branch; absent a `merge` reducer those fields are unguarded (§4/§12.8). A real per-field model
  // lands with native Revisium typing; until then the entry-kind heuristic surfaces the hazard.
  if (par.branches.length < 2) return;
  if (Object.keys(join.merge ?? {}).length > 0) return;
  const writers = par.branches.filter((b) => {
    const entry = template.nodes[b.entry];
    return entry?.kind === 'agent' || entry?.kind === 'script';
  });
  if (writers.length >= 2) {
    d.error('MERGE_MISSING', `join ${join.id} has ${writers.length} writer branches but no merge reducer`, {
      nodeId: join.id,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 9 — verdict-vocabulary closure.
// ─────────────────────────────────────────────────────────────────────────────

function ruleVerdictClosure(template: Template, d: DiagSink): void {
  const domain = template.verdicts?.domain ?? [];
  const domainSet = new Set(domain);
  const core = new Set<string>(CORE_VERDICTS);

  // 9a no domain label shadows a core label.
  for (const label of domain) {
    if (core.has(label)) {
      d.error('VERDICT_DOMAIN_SHADOWS_CORE', `domain verdict "${label}" shadows a core verdict`);
    }
  }

  const used = new Set<string>();
  for (const node of Object.values(template.nodes)) {
    checkGuardVerdictLabels(node, core, domainSet, used, d); //  9b verdict.* guard labels ∈ domain
    checkGateOutcomesSubset(node, domainSet, used, d); //        9c humanGate.outcomes ⊆ domain
  }

  // 9d declared-but-unused (warning).
  for (const label of domain) {
    if (!used.has(label)) d.warn('VERDICT_DECLARED_UNUSED', `domain verdict "${label}" is declared but never used`);
  }
}

/** 9b — every verdict.* guard label on a node is a declared domain label (a core label is a hard error). */
function checkGuardVerdictLabels(
  node: Node,
  core: Set<string>,
  domainSet: Set<string>,
  used: Set<string>,
  d: DiagSink,
): void {
  for (const cond of guardConditionsOf(node)) {
    collectVerdictLabels(cond, (label) => {
      used.add(label);
      if (core.has(label)) {
        d.error('VERDICT_CORE_IN_GUARD', `node ${node.id} guard uses core verdict "${label}" (route it structurally)`, {
          nodeId: node.id,
        });
      } else if (!domainSet.has(label)) {
        d.error('VERDICT_UNDECLARED', `node ${node.id} guard uses undeclared verdict "${label}"`, {
          nodeId: node.id,
        });
      }
    });
  }
}

/** 9c — a humanGate's declared outcomes must all be declared domain labels. */
function checkGateOutcomesSubset(node: Node, domainSet: Set<string>, used: Set<string>, d: DiagSink): void {
  if (node.kind !== 'humanGate') return;
  for (const o of node.outcomes) {
    used.add(o);
    if (!domainSet.has(o)) {
      d.error('GATE_OUTCOME_NOT_SUBSET', `gate ${node.id} outcome "${o}" is not in verdicts.domain`, {
        nodeId: node.id,
      });
    }
  }
}

function collectVerdictLabels(cond: Condition, visit: (label: string) => void): void {
  switch (cond.op) {
    case 'verdict.eq':
      visit(cond.value);
      break;
    case 'verdict.in':
      cond.value.forEach(visit);
      break;
    case 'all':
    case 'any':
      cond.of.forEach((c) => collectVerdictLabels(c, visit));
      break;
    case 'not':
      collectVerdictLabels(cond.cond, visit);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared — collect every guard Condition reachable on a node.
// ─────────────────────────────────────────────────────────────────────────────

function guardConditionsOf(node: Node): Condition[] {
  if (node.kind !== 'choice' && node.kind !== 'humanGate') return [];
  return node.branches.filter(isGuardedBranch).map((b) => b.when);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 14 — dataflow (produces/consumes, 0016 §7). STATIC only: the adapter persists/hydrates at runtime
// (0016 §5/§6); the core neither stores content nor reads it. Dominance proves a producer ran (presence);
// the runtime `revo.InputMissing` guard + the freshness rule cover what static analysis cannot.
// ─────────────────────────────────────────────────────────────────────────────

function ruleDataflow(template: Template, ids: Set<string>, d: DiagSink): void {
  const nodes = template.nodes;
  const hasEntry = !!template.entry && ids.has(template.entry);
  const dom = hasEntry ? dominators(template, template.entry) : new Map<string, Set<string>>();
  const membership = branchMembership(template);
  const cyclesByNode = consumerStaleCycles(template);

  // PRODUCES_NAME_DUP — warning: the grammar keys consumes by NODE, so a duplicate name is a clarity
  // guard, not a resolution bug.
  const producedNames = new Map<string, string>();
  for (const node of Object.values(nodes)) {
    if ((node.kind === 'agent' || node.kind === 'script') && node.produces) {
      const prev = producedNames.get(node.produces.name);
      if (prev && prev !== node.id) {
        d.warn('PRODUCES_NAME_DUP', `nodes "${prev}" and "${node.id}" both produce "${node.produces.name}"`, {
          nodeId: node.id,
        });
      } else if (!prev) producedNames.set(node.produces.name, node.id);
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.kind !== 'agent' && node.kind !== 'script') continue;
    const consumes = node.consumes ?? [];
    const seenAs = new Set<string>();
    for (let i = 0; i < consumes.length; i++) {
      const ref = consumes[i];
      const path = `consumes[${i}]`;
      if (seenAs.has(ref.as)) {
        d.error('CONSUMES_AS_DUP', `node "${node.id}" consumes two inputs as "${ref.as}"`, { nodeId: node.id, path });
      } else seenAs.add(ref.as);

      const producer = nodes[ref.node];
      if (!producer) {
        d.error('CONSUMES_NODE_UNRESOLVED', `node "${node.id}" consumes from unknown node "${ref.node}"`, {
          nodeId: node.id,
          path,
        });
        continue;
      }
      const canProduce = (producer.kind === 'agent' || producer.kind === 'script') && !!producer.produces;
      if (!canProduce) {
        d.error('CONSUMES_PRODUCER_MISSING', `node "${node.id}" consumes from "${ref.node}" which declares no produces`, {
          nodeId: node.id,
          path,
        });
        continue;
      }

      // Dominance: the producer must run before the consumer on EVERY path (entry can never be dominated
      // by another node → a consuming entry node is always flagged here).
      const dominated = hasEntry && ref.node !== node.id && dom.get(node.id)?.has(ref.node) === true;
      if (!dominated) {
        const msg = `producer "${ref.node}" does not run before "${node.id}" on every path`;
        if (ref.optional === true) d.warn('CONSUMES_NOT_DOMINATED', msg, { nodeId: node.id, path });
        else d.error('CONSUMES_NOT_DOMINATED', msg, { nodeId: node.id, path });
      }

      // Freshness: a consumer inside a loop the producer is NOT on can silently reuse a stale output.
      const iteration = ref.iteration ?? 'latest';
      if (iteration === 'latest' && ref.staleOk !== true) {
        const risky = (cyclesByNode.get(node.id) ?? []).some((cycle) => !cycle.has(ref.node));
        if (risky) {
          d.warn(
            'CONSUMES_STALE_RISK',
            `node "${node.id}" can re-enter a loop without re-running producer "${ref.node}" (iteration:'latest') — set staleOk or use iteration:'all'/N`,
            { nodeId: node.id, path },
          );
        }
      }

      // Cross-parallel: consuming a sibling branch's output is unsafe (the branch may be cancelled).
      const consumerBranch = membership.get(node.id);
      const producerBranch = membership.get(ref.node);
      if (
        consumerBranch &&
        producerBranch &&
        consumerBranch.parallel === producerBranch.parallel &&
        consumerBranch.branch !== producerBranch.branch
      ) {
        d.error('CONSUMES_CROSS_PARALLEL_UNSAFE', `node "${node.id}" consumes "${ref.node}" from a sibling parallel branch`, {
          nodeId: node.id,
          path,
        });
      }
    }
  }
}

/** Standard iterative dominator sets over STRUCTURAL edges from `entry`. dom(entry) = {entry}. */
function dominators(template: Template, entry: string): Map<string, Set<string>> {
  const reachable = [...reachableFrom(template, entry)].filter((id) => template.nodes[id]);
  const preds = new Map<string, string[]>();
  for (const id of reachable) preds.set(id, []);
  for (const id of reachable) {
    for (const [, t] of structuralEdges(template.nodes[id]!)) if (preds.has(t)) preds.get(t)!.push(id);
  }
  const all = new Set(reachable);
  const dom = new Map<string, Set<string>>();
  for (const id of reachable) dom.set(id, new Set(all));
  dom.set(entry, new Set([entry]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      if (id === entry) continue;
      const ps = preds.get(id)!;
      let next: Set<string>;
      if (ps.length === 0) next = new Set([id]);
      else {
        next = new Set(dom.get(ps[0])!);
        for (let i = 1; i < ps.length; i++) {
          const dp = dom.get(ps[i])!;
          for (const x of [...next]) if (!dp.has(x)) next.delete(x);
        }
      }
      next.add(id);
      const old = dom.get(id)!;
      if (old.size !== next.size || [...next].some((x) => !old.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** For each node, the cycles (node-sets) it sits on — feeds the loop-freshness check (CONSUMES_STALE_RISK). */
function consumerStaleCycles(template: Template): Map<string, Array<Set<string>>> {
  const out = new Map<string, Array<Set<string>>>();
  for (const { from, to } of findBackEdges(template)) {
    const cycle = cycleNodes(template, to, from);
    for (const id of cycle) {
      const list = out.get(id) ?? [];
      list.push(cycle);
      out.set(id, list);
    }
  }
  return out;
}

/** Map each node to its (parallel, branch) membership, if any — for cross-branch dataflow safety. */
function branchMembership(template: Template): Map<string, { parallel: string; branch: string }> {
  const out = new Map<string, { parallel: string; branch: string }>();
  for (const par of Object.values(template.nodes)) {
    if (par.kind !== 'parallel') continue;
    for (const br of par.branches) {
      for (const id of branchSubgraph(template, br.entry, par.join)) out.set(id, { parallel: par.id, branch: br.id });
    }
  }
  return out;
}
