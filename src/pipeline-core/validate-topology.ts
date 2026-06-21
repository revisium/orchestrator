import { CONDITION_OPS, TERMINAL_STATUSES, isDefaultBranch } from './types.js';
import type { Condition, Node, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { outgoingEdges } from './validate-edges.js';
import { guardConditionsOf, reachableFrom } from './validate-graph.js';

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — single entry.
// ─────────────────────────────────────────────────────────────────────────────

export function ruleSingleEntry(template: Template, ids: Set<string>, d: DiagSink): void {
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

export function ruleReferencesResolve(template: Template, ids: Set<string>, d: DiagSink): void {
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

export function ruleTerminals(template: Template, d: DiagSink): void {
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

export function ruleConditionGrammar(template: Template, d: DiagSink): void {
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

export function ruleTotalRouting(template: Template, d: DiagSink): void {
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

export function ruleReachability(template: Template, ids: Set<string>, d: DiagSink): void {
  if (!template.entry || !ids.has(template.entry)) return; // rule 1 already flagged it
  const reachable = reachableFrom(template, template.entry);
  for (const id of ids) {
    if (!reachable.has(id)) d.error('UNREACHABLE_NODE', `node "${id}" is unreachable from entry`, { nodeId: id });
  }
}
