import { isGuardedBranch } from './types.js';
import type { Condition, Node, Scope, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { backwardReach, cycleNodes, findBackEdges, forwardReach, guardConditionsOf } from './validate-graph.js';

// Spec note (two ambiguities resolved against the canonical example):
//  1. The spec says "a terminating cap-guard (counter.gte)", but the canonical example expresses the SAME bound as
//     `counter.lt K` on the CONTINUE edge with the default routing OUT (once the counter reaches K the
//     guard fails and control falls through to blockedEnd). Both make the loop finite, so we accept
//     EITHER: a cycle is counter-bounded iff some `choice` on it has a guard referencing a `counter.*`
//     over a scope INCREMENTED on the cycle.
//  2. The analyst↔planGate `changes_requested` loop carries NO counter — it is bounded only by human
//     judgment. The spec makes a human-driven loop legitimately unbounded ("durable wait is free … for
//     human-driven runs"). So a cycle that passes through a `humanGate` is also accepted.
// An AUTOMATED loop (agents/scripts/choices only) with no counter is rejected (LOOP_UNBOUNDED).

export function ruleLoopCap(template: Template, d: DiagSink): void {
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

export function ruleCounterScopes(template: Template, d: DiagSink): void {
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
 * 7c — a reset scope is a STRICT ancestor of every node that reads/increments it. The scope's
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

/**
 * 7d — a counter scope may not span a parallel/join boundary (v1). The region is the increment/read endpoints
 * PLUS every node on a structural path between them: a counter incremented before a fan-out and read after the
 * join (or whose endpoints sit in different branches) crosses the boundary and is unsafe in v1.
 */
function checkScopeDoesNotSpanParallel(template: Template, scopeId: string, d: DiagSink): void {
  const region = scopeRegionBetween(template, nodesIncrementing(template, scopeId), nodesReadingScope(template, scopeId));
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

/** Endpoints plus every node on some structural path from an increment site to a reader (forwardReach ∩ backwardReach). */
function scopeRegionBetween(template: Template, incrementSites: string[], readers: string[]): Set<string> {
  const region = new Set<string>([...incrementSites, ...readers]);
  for (const inc of incrementSites) {
    const fwd = forwardReach(template, inc);
    for (const reader of readers) {
      if (!fwd.has(reader)) continue;
      const back = backwardReach(template, reader);
      for (const id of fwd) if (back.has(id)) region.add(id);
    }
  }
  return region;
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
