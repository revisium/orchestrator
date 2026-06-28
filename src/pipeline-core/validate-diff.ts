/**
 * validate-diff — validation rule 13, the template diff classifier. Classifies the change from one template
 * to another (it does not validate a single template — that is validateTemplate's job). Lifted from
 * validate.ts as a separate public-API surface; validate.ts re-exports it so callers are unaffected.
 */

import type { Diagnostic, Node, Template } from './types.js';
import { outgoingEdges } from './validate-edges.js';

export type DiffKind = 'safe' | 'breaking' | 'invalid';
export type TemplateDiff = { kind: DiffKind; diagnostics: Diagnostic[] };

/**
 * Classify the change from `old` → `next`. The enabler for a FUTURE in-flight migration; v1
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
    acc.escalate('invalid'); // a reused id with a different kind is invalid
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
  // `input` is listed for parity with the doc above; it is a Decision field, not a Node key, so it never
  // reaches this loop — harmless, and keeps the code aligned with its documented safe-set.
  const SAFE_KEYS = new Set(['id', 'displayName', 'reason', 'input']);
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
