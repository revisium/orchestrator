



import type { Diagnostic, Node, Template } from './types.js';
import { outgoingEdges } from './validate-edges.js';

export type DiffKind = 'safe' | 'breaking' | 'invalid';
export type TemplateDiff = { kind: DiffKind; diagnostics: Diagnostic[] };








export function classifyTemplateDiff(old: Template, next: Template): TemplateDiff {
  const acc = newDiffAccumulator();
  const oldNodes = old.nodes ?? {};
  const nextNodes = next.nodes ?? {};
  const oldIds = new Set(Object.keys(oldNodes));
  const nextIds = new Set(Object.keys(nextNodes));

  for (const id of oldIds) {
    if (!nextIds.has(id)) {
      acc.escalate('breaking');
      acc.diagnostics.push({ code: 'DIFF_NODE_DELETED', severity: 'error', message: `node "${id}" was deleted`, nodeId: id });
    }
  }

  for (const id of nextIds) {
    const before = oldNodes[id];
    if (before) classifyExistingNodeChange(id, before, nextNodes[id], acc);
  }

  classifyTopLevelDiff(old, next, acc);
  return { kind: acc.kind, diagnostics: acc.diagnostics };
}


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


function classifyExistingNodeChange(id: string, before: Node, after: Node, acc: DiffAccumulator): void {
  if (before.kind !== after.kind) {
    acc.escalate('invalid');
    acc.diagnostics.push({
      code: 'DIFF_ID_REUSED_INCOMPATIBLE',
      severity: 'error',
      message: `node "${id}" kind changed ${before.kind} → ${after.kind} (id reuse with different kind)`,
      nodeId: id,
    });
    return;
  }
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
  if (!sameTopology(before, after)) {
    acc.escalate('breaking');
    acc.diagnostics.push({
      code: 'DIFF_NODE_TOPOLOGY_CHANGED',
      severity: 'error',
      message: `node "${id}" outgoing topology changed`,
      nodeId: id,
    });
  }
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


function comparePath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}





function unclassifiedFieldChange(before: Node, after: Node): string {
  const SAFE_KEYS = new Set(['id', 'displayName', 'reason', 'input']);
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (SAFE_KEYS.has(key)) continue;
    if (isTopologyKey(key)) continue;
    if (key === 'resultSchema') continue;
    const bv = JSON.stringify((before as Record<string, unknown>)[key]);
    const av = JSON.stringify((after as Record<string, unknown>)[key]);
    if (bv !== av) changed.push(key);
  }
  return changed.join(', ');
}

function isTopologyKey(key: string): boolean {
  return key === 'next' || key === 'branches' || key === 'catch' || key === 'escalateTo' || key === 'join';
}
