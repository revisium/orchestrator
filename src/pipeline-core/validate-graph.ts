import { isGuardedBranch } from './types.js';
import type { Condition, Node, Template } from './types.js';
import { outgoingEdges } from './validate-edges.js';

/** Forward (non-catch, non-escalate) edges — `catch`/`escalateTo` are failure routes, not loop edges. */
export function structuralEdges(node: Node): Array<[string, string]> {
  return outgoingEdges(node).filter(([p]) => !p.startsWith('catch') && p !== 'escalateTo');
}

/** Nodes reachable from `entry` over EVERY outgoing edge (catch/escalate included). */
export function reachableFrom(template: Template, entry: string): Set<string> {
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

/** Nodes structurally reachable from `start` (catch/escalate excluded — failure routes are not flow). */
export function forwardReach(template: Template, start: string): Set<string> {
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

/** Nodes that can structurally reach `target` (predecessor walk over structural edges). */
export function backwardReach(template: Template, target: string): Set<string> {
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

/** Back-edges = forward edges whose target is an ancestor on the DFS stack (a cycle re-entry). */
export function findBackEdges(template: Template): Array<{ from: string; to: string }> {
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

/** Nodes on a cycle that re-enters `to` via the back-edge from `from` (path to→…→from + from). */
export function cycleNodes(template: Template, to: string, from: string): Set<string> {
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

/** Nodes reachable from a branch `entry`, stopping AT the join (the join itself is not a member). */
export function branchSubgraph(template: Template, entry: string, joinId: string): Set<string> {
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

/** Every guard Condition on a node (choice/humanGate branches that carry a `when`). */
export function guardConditionsOf(node: Node): Condition[] {
  if (node.kind !== 'choice' && node.kind !== 'humanGate') return [];
  return node.branches.filter(isGuardedBranch).map((b) => b.when);
}
