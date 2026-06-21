/**
 * pipeline-core/validate.ts — the authoritative install-time validator (§12). `validateTemplate` is the
 * orchestrator: it runs every rule (each in its own sibling module) in a fixed order and returns every
 * finding. The graph-shape rules live in validate-topology, loop/counter boundedness in validate-loops,
 * parallel/join in validate-parallel, verdict closure in validate-verdict, produces/consumes in
 * validate-dataflow, conflict-matrix in validate-conflicts, capability-refs in validate-capability; the
 * diff classifier (rule 13) is re-exported from validate-diff. Only the two declaration-hygiene rules
 * (id hygiene, per-node failure policy) — which belong to no graph category — stay here.
 *
 * Pure: zero I/O, no clocks. Each §12 rule is its own collector; `validateTemplate` returns every
 * finding (it does not stop at the first error). Codes are stable (tested against).
 */

import { FAILURE_POLICIES, isRevoErrorCode } from './types.js';
import type { Diagnostic, Node, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import {
  ruleSingleEntry,
  ruleReferencesResolve,
  ruleTerminals,
  ruleConditionGrammar,
  ruleTotalRouting,
  ruleReachability,
} from './validate-topology.js';
import { ruleLoopCap, ruleCounterScopes } from './validate-loops.js';
import { ruleParallelJoin } from './validate-parallel.js';
import { ruleVerdictClosure } from './validate-verdict.js';
import { ruleDataflow } from './validate-dataflow.js';
import { ruleConflictMatrix } from './validate-conflicts.js';
import { ruleCapabilityRefs } from './validate-capability.js';

export { classifyTemplateDiff } from './validate-diff.js';
export type { DiffKind, TemplateDiff } from './validate-diff.js';

const NODE_ID_PATTERN = /^[A-Za-z]\w*$/;

// ─────────────────────────────────────────────────────────────────────────────
// Public entry.
// ─────────────────────────────────────────────────────────────────────────────

/** Run all §12 rules. Returns every diagnostic; empty ⇒ the template is valid. */
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
