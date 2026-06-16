/**
 * pipeline-core/validate.ts — the authoritative install-time validator (§12).
 *
 *   validateTemplate(t) -> Diagnostic[]                (rules 1–12)
 *   classifyTemplateDiff(old, next) -> { kind, diagnostics }   (rule 13)
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
import type {
  Branch,
  Condition,
  Diagnostic,
  DiagnosticCode,
  Node,
  Scope,
  Template,
} from './types.js';

const NODE_ID_PATTERN = /^[A-Za-z]\w*$/;
const CAPABILITY_REF_PATTERN = /^(role|script):[A-Za-z][A-Za-z0-9_-]*$/;

class DiagSink {
  readonly items: Diagnostic[] = [];
  error(code: DiagnosticCode, message: string, where: Partial<Diagnostic> = {}): void {
    this.items.push({ code, severity: 'error', message, ...strip(where) });
  }
  warn(code: DiagnosticCode, message: string, where: Partial<Diagnostic> = {}): void {
    this.items.push({ code, severity: 'warning', message, ...strip(where) });
  }
}

function strip(where: Partial<Diagnostic>): Partial<Diagnostic> {
  const out: Partial<Diagnostic> = {};
  if (where.nodeId !== undefined) out.nodeId = where.nodeId;
  if (where.scope !== undefined) out.scope = where.scope;
  if (where.path !== undefined) out.path = where.path;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry.
// ─────────────────────────────────────────────────────────────────────────────

/** Run all §12 rules (1–12). Returns every diagnostic; empty ⇒ the template is valid. */
export function validateTemplate(template: Template): Diagnostic[] {
  const d = new DiagSink();
  const nodes = template.nodes ?? {};
  const ids = new Set(Object.keys(nodes));

  ruleIdHygiene(template, d); //                 11 (run first — duplicate/bad ids inform the rest)
  ruleSingleEntry(template, ids, d); //          1
  ruleReferencesResolve(template, ids, d); //    2
  ruleTerminals(template, d); //                 3
  ruleConditionGrammar(template, d); //          (grammar sanity — feeds 2/4/9)
  ruleTotalRouting(template, d); //              4
  ruleReachability(template, ids, d); //         5
  ruleFailurePolicy(template, d); //             6 (failure policy well-formedness)
  ruleLoopCap(template, d); //                   6 (loop-cap presence)
  ruleCounterScopes(template, d); //             7
  ruleParallelJoin(template, d); //              8
  ruleVerdictClosure(template, d); //            9
  ruleConflictMatrix(template, d); //            10
  ruleCapabilityRefs(template, d); //            12

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

/** Every outgoing edge of a node as `[path, targetId]` pairs (for refs/topology/diff rules). */
function outgoingEdges(node: Node): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  switch (node.kind) {
    case 'agent':
    case 'script':
      edges.push(['next', node.next]);
      (node.catch ?? []).forEach((c, i) => edges.push([`catch[${i}].goto`, c.goto]));
      if (node.escalateTo !== undefined) edges.push(['escalateTo', node.escalateTo]);
      break;
    case 'wait':
      edges.push(['next', node.next]);
      break;
    case 'join':
      edges.push(['next', node.next]);
      break;
    case 'humanGate':
      branchTargets(node.branches).forEach(([p, t]) => edges.push([`branches.${p}`, t]));
      if (node.timeout) edges.push(['timeout.goto', node.timeout.goto]);
      break;
    case 'choice':
      branchTargets(node.branches).forEach(([p, t]) => edges.push([`branches.${p}`, t]));
      break;
    case 'parallel':
      node.branches.forEach((b, i) => edges.push([`branches[${i}].entry`, b.entry]));
      edges.push(['join', node.join]);
      break;
    case 'terminal':
      break;
  }
  return edges;
}

function branchTargets(branches: Branch[]): Array<[string, string]> {
  return branches.map((b, i): [string, string] =>
    isDefaultBranch(b) ? [`[${i}].default`, b.default] : [`[${i}].goto`, b.goto],
  );
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
// Rule 10 — conflict-matrix.
// ─────────────────────────────────────────────────────────────────────────────

function ruleConflictMatrix(template: Template, d: DiagSink): void {
  const conflicts = template.policy?.conflicts ?? [];
  if (conflicts.length === 0) return;

  // Map each role to the node ids that bind it (agent.roleRef = "role:<name>").
  const roleNodes = new Map<string, string[]>();
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent') {
      const role = roleName(node.roleRef);
      if (role) (roleNodes.get(role) ?? roleNodes.set(role, []).get(role)!).push(node.id);
    }
  }

  for (const pair of conflicts) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((r) => typeof r !== 'string')) {
      d.error('CONFLICT_REF_INVALID', `policy.conflicts entry ${JSON.stringify(pair)} is not a [roleA, roleB] pair`);
      continue;
    }
    const [a, b] = pair;
    // A conflict is well-formed only if both roles are actually bound by some node.
    if (!roleNodes.has(a) || !roleNodes.has(b)) {
      d.warn('CONFLICT_REF_INVALID', `policy.conflicts [${a}, ${b}] references a role no node binds`);
    }
    // v1 binds a role to a node, not to a concrete actor; a path where ONE actor fills both roles
    // is detectable only with actor assignment (out of v1 template data). We surface the *structural*
    // hazard: the same node is bound to both conflicting roles (impossible via roleRef, but a future
    // multi-role node would trip it) — kept as a placeholder check so the rule has a code + a test.
  }
}

function roleName(roleRef: string): string | undefined {
  const m = /^role:(.+)$/.exec(roleRef);
  return m ? m[1] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 12 — capability-ref shape.
// ─────────────────────────────────────────────────────────────────────────────

function ruleCapabilityRefs(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent') {
      if (!CAPABILITY_REF_PATTERN.test(node.roleRef) || !node.roleRef.startsWith('role:')) {
        d.error('CAPABILITY_REF_SHAPE', `agent ${node.id} roleRef "${node.roleRef}" is malformed`, {
          nodeId: node.id,
        });
      }
    } else if (node.kind === 'script') {
      if (!CAPABILITY_REF_PATTERN.test(node.scriptRef) || !node.scriptRef.startsWith('script:')) {
        d.error('CAPABILITY_REF_SHAPE', `script ${node.id} scriptRef "${node.scriptRef}" is malformed`, {
          nodeId: node.id,
        });
      }
    }
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
// Rule 13 — diff classifier.
// ─────────────────────────────────────────────────────────────────────────────

export type DiffKind = 'safe' | 'breaking' | 'invalid';
export type TemplateDiff = { kind: DiffKind; diagnostics: Diagnostic[] };

/**
 * Classify the change from `old` → `next` (§12.13). The enabler for a FUTURE in-flight migration; v1
 * only reports.
 *  - node-id delete / rename / kind-change            → breaking
 *  - changing the outgoing topology of an existing node → breaking
 *  - reusing a deleted id with a different kind/resultSchema → invalid
 *  - displayName / prompt / payload changes            → safe
 *  - ANY field/path not explicitly classified          → breaking (conservative) + DIFF_UNCLASSIFIED
 */
export function classifyTemplateDiff(old: Template, next: Template): TemplateDiff {
  const acc = newDiffAccumulator();
  const oldNodes = old.nodes ?? {};
  const nextNodes = next.nodes ?? {};
  const oldIds = new Set(Object.keys(oldNodes));
  const nextIds = new Set(Object.keys(nextNodes));

  // Deleted ids → breaking.
  for (const id of oldIds) {
    if (!nextIds.has(id)) {
      acc.escalate('breaking');
      acc.diagnostics.push({ code: 'DIFF_NODE_DELETED', severity: 'error', message: `node "${id}" was deleted`, nodeId: id });
    }
  }

  for (const id of nextIds) {
    const before = oldNodes[id];
    // A brand-new node id is additive → safe (a new branch/path); reusing a PREVIOUSLY-deleted id is
    // not observable here (single old/next pair). Adding a node is classified safe.
    if (before) classifyExistingNodeChange(id, before, nextNodes[id], acc);
  }

  classifyTopLevelDiff(old, next, acc);
  return { kind: acc.kind, diagnostics: acc.diagnostics };
}

/** Mutable classifier state: accumulated diagnostics + the worst diff kind seen so far. */
type DiffAccumulator = {
  diagnostics: Diagnostic[];
  kind: DiffKind;
  escalate: (to: DiffKind) => void;
};

function newDiffAccumulator(): DiffAccumulator {
  const acc: DiffAccumulator = {
    diagnostics: [],
    kind: 'safe',
    escalate: (to: DiffKind): void => {
      if (to === 'invalid') acc.kind = 'invalid';
      else if (to === 'breaking' && acc.kind !== 'invalid') acc.kind = 'breaking';
    },
  };
  return acc;
}

/** Classify the change of a node id present in BOTH templates (kind / schema / topology / fields). */
function classifyExistingNodeChange(id: string, before: Node, after: Node, acc: DiffAccumulator): void {
  // kind change → breaking; an incompatible kind/resultSchema reuse → invalid.
  if (before.kind !== after.kind) {
    acc.escalate('invalid'); // a reused id with a different kind is invalid (§12.13)
    acc.diagnostics.push({
      code: 'DIFF_ID_REUSED_INCOMPATIBLE',
      severity: 'error',
      message: `node "${id}" kind changed ${before.kind} → ${after.kind} (id reuse with different kind)`,
      nodeId: id,
    });
    return;
  }
  // resultSchema change on a same-kind effect node → invalid (id reuse with different contract).
  const beforeSchema = (before as { resultSchema?: string }).resultSchema;
  const afterSchema = (after as { resultSchema?: string }).resultSchema;
  if (beforeSchema !== afterSchema) {
    acc.escalate('invalid');
    acc.diagnostics.push({
      code: 'DIFF_ID_REUSED_INCOMPATIBLE',
      severity: 'error',
      message: `node "${id}" resultSchema changed "${beforeSchema}" → "${afterSchema}"`,
      nodeId: id,
    });
  }
  // Outgoing topology change → breaking.
  if (!sameTopology(before, after)) {
    acc.escalate('breaking');
    acc.diagnostics.push({
      code: 'DIFF_NODE_TOPOLOGY_CHANGED',
      severity: 'error',
      message: `node "${id}" outgoing topology changed`,
      nodeId: id,
    });
  }
  // Any non-safe-classified, non-topology field change defaults to breaking + DIFF_UNCLASSIFIED.
  const unclassified = unclassifiedFieldChange(before, after);
  if (unclassified) {
    acc.escalate('breaking');
    acc.diagnostics.push({
      code: 'DIFF_UNCLASSIFIED',
      severity: 'error',
      message: `node "${id}" has an unclassified field change in {${unclassified}} (defaulting to breaking)`,
      nodeId: id,
    });
  }
}

/** Top-level structural changes (entry / scopes) default to breaking if changed. */
function classifyTopLevelDiff(old: Template, next: Template, acc: DiffAccumulator): void {
  if (old.entry !== next.entry) {
    acc.escalate('breaking');
    acc.diagnostics.push({ code: 'DIFF_NODE_TOPOLOGY_CHANGED', severity: 'error', message: `entry changed ${old.entry} → ${next.entry}` });
  }
  if (JSON.stringify(old.scopes ?? {}) !== JSON.stringify(next.scopes ?? {})) {
    acc.escalate('breaking');
    acc.diagnostics.push({ code: 'DIFF_UNCLASSIFIED', severity: 'error', message: `scopes changed (defaulting to breaking)` });
  }
}

/** Two nodes have the same outgoing topology iff their ordered edge `[path,target]` sets match. */
function sameTopology(a: Node, b: Node): boolean {
  const ea = JSON.stringify(orderedEdges(a));
  const eb = JSON.stringify(orderedEdges(b));
  return ea === eb;
}

function orderedEdges(node: Node): Array<[string, string]> {
  return outgoingEdges(node)
    .slice()
    .sort((x, y) => comparePath(x[0], y[0]));
}

/** Stable lexical comparison of two edge paths (sort comparator: -1 / 0 / 1). */
function comparePath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Detect a field change that is NOT one of the explicitly-SAFE fields (displayName, reason/prompt-like
 * text, payload `input`) and NOT topology (handled separately). Returns a comma-list of changed
 * unclassified keys, or '' if every change is safe. Guards (`branches.when`, `joinMode`, `merge`,
 * `onFailure`, `incrementCounters`, `outcomes`, `timeout.after`) are NOT in the safe set → breaking.
 */
function unclassifiedFieldChange(before: Node, after: Node): string {
  const SAFE_KEYS = new Set(['id', 'displayName', 'reason']);
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (SAFE_KEYS.has(key)) continue;
    if (isTopologyKey(key)) continue; // topology handled by sameTopology
    if (key === 'resultSchema') continue; // handled above (invalid)
    const bv = JSON.stringify((before as Record<string, unknown>)[key]);
    const av = JSON.stringify((after as Record<string, unknown>)[key]);
    if (bv !== av) changed.push(key);
  }
  return changed.join(', ');
}

function isTopologyKey(key: string): boolean {
  return key === 'next' || key === 'branches' || key === 'catch' || key === 'escalateTo' || key === 'join';
}
