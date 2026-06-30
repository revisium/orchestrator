import { isGuardedBranch } from './types.js';
import type { Condition, Node, Scope, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { backwardReach, branchSubgraph, cycleNodes, findBackEdges, forwardReach, guardConditionsOf } from './validate-graph.js';


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


function scopesIncrementedOnCycle(template: Template, cycle: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of cycle) {
    const node = template.nodes[id];
    if (node && 'incrementCounters' in node) for (const s of node.incrementCounters ?? []) out.add(s);
  }
  return out;
}


function choiceGatesCycleByCounter(template: Template, id: string, incrementedOnCycle: Set<string>): boolean {
  const node = template.nodes[id];
  if (node?.kind !== 'choice') return false;
  return node.branches.filter(isGuardedBranch).some((b) => conditionGatesOnScopes(b.when, incrementedOnCycle));
}


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

  checkScopeParentsAndCycles(scopes, scopeIds, d);
  checkScopesDeclared(template, scopeIds, d);
  for (const scopeId of scopeIds) checkScopeStrictAncestry(template, scopeId, d);
  for (const scopeId of Object.keys(scopes)) checkScopeDoesNotSpanParallel(template, scopeId, d);
}


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




function checkScopeDoesNotSpanParallel(template: Template, scopeId: string, d: DiagSink): void {
  const incrementSites = nodesIncrementing(template, scopeId);
  const readers = nodesReadingScope(template, scopeId);
  const region = scopeRegionBetween(template, incrementSites, readers);
  const endpoints = new Set([...incrementSites, ...readers]);
  for (const id of region) {
    const node = template.nodes[id];
    if (node?.kind === 'parallel' && parallelBranchTouchesScope(template, node, endpoints)) {
      d.error('SCOPE_SPANS_PARALLEL', `scope "${scopeId}" spans a ${node.kind} boundary (${id})`, {
        nodeId: id,
        scope: scopeId,
      });
    } else if (node?.kind === 'join') {
      const owners = Object.values(template.nodes).filter((candidate) =>
        candidate.kind === 'parallel' && candidate.join === id && region.has(candidate.id),
      );
      const safeJoin =
        owners.length > 0 &&
        owners.every((owner) => owner.kind === 'parallel' && !parallelBranchTouchesScope(template, owner, endpoints));
      if (!safeJoin) {
        d.error('SCOPE_SPANS_PARALLEL', `scope "${scopeId}" spans a ${node.kind} boundary (${id})`, {
          nodeId: id,
          scope: scopeId,
        });
      }
    }
  }
}

function parallelBranchTouchesScope(
  template: Template,
  parallelNode: Extract<Node, { kind: 'parallel' }>,
  endpoints: Set<string>,
): boolean {
  const interior = parallelBranchInterior(template, parallelNode);
  for (const endpoint of endpoints) {
    if (interior.has(endpoint)) return true;
  }
  return false;
}

function parallelBranchInterior(template: Template, parallelNode: Extract<Node, { kind: 'parallel' }>): Set<string> {
  const seen = new Set<string>();
  for (const branch of parallelNode.branches) {
    for (const id of branchSubgraph(template, branch.entry, parallelNode.join)) seen.add(id);
  }
  return seen;
}


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
