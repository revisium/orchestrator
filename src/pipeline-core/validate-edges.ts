/**
 * validate-edges — the single model of a node's outgoing edges, shared by the refs (rule 2), topology
 * (rule 3), reachability (rule 5), loop (rule 6), and diff (rule 13) rules. One edge model so those
 * rules cannot disagree about what a node points at.
 */

import { isDefaultBranch } from './types.js';
import type { Branch, Node } from './types.js';

/** Every outgoing edge of a node as `[path, targetId]` pairs. */
export function outgoingEdges(node: Node): Array<[string, string]> {
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
