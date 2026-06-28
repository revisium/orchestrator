






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


export function validateTemplate(template: Template): Diagnostic[] {
  const d = new DiagSink();
  const nodes = template.nodes ?? {};
  const ids = new Set(Object.keys(nodes));
  const normalized: Template = { ...template, nodes };

  ruleIdHygiene(normalized, d);
  ruleSingleEntry(normalized, ids, d);
  ruleReferencesResolve(normalized, ids, d);
  ruleTerminals(normalized, d);
  ruleConditionGrammar(normalized, d);
  ruleTotalRouting(normalized, d);
  ruleReachability(normalized, ids, d);
  ruleFailurePolicy(normalized, d);
  ruleLoopCap(normalized, d);
  ruleCounterScopes(normalized, d);
  ruleParallelJoin(normalized, d);
  ruleVerdictClosure(normalized, d);
  ruleConflictMatrix(normalized, d);
  ruleCapabilityRefs(normalized, d);
  ruleDataflow(normalized, ids, d);

  return d.items;
}

function ruleIdHygiene(template: Template, d: DiagSink): void {
  const seen = new Set<string>();
  for (const [key, node] of Object.entries(template.nodes ?? {})) {
    checkNodeKeyHygiene(key, node, seen, d);
    seen.add(key);
  }
  checkCatchCodeVerdictCollisions(template, d);
}


function checkNodeKeyHygiene(key: string, node: Node | undefined, seen: Set<string>, d: DiagSink): void {
  if (node?.id !== undefined && node.id !== key) {
    d.error('ID_BAD_PATTERN', `node "${key}" has mismatching id "${node.id}"`, { nodeId: key });
  }
  if (!NODE_ID_PATTERN.test(key)) {
    d.error('ID_BAD_PATTERN', `node id "${key}" does not match ${NODE_ID_PATTERN}`, { nodeId: key });
  }
  if (seen.has(key)) d.error('ID_DUPLICATE', `duplicate node id "${key}"`, { nodeId: key });
}


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

function ruleFailurePolicy(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent' || node.kind === 'script') checkNodeFailurePolicy(node, d);
  }
}


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
