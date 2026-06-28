import { CORE_VERDICTS } from './types.js';
import type { Condition, Node, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { guardConditionsOf } from './validate-graph.js';

export function ruleVerdictClosure(template: Template, d: DiagSink): void {
  const domain = template.verdicts?.domain ?? [];
  const domainSet = new Set(domain);
  const core = new Set<string>(CORE_VERDICTS);

  for (const label of domain) {
    if (core.has(label)) {
      d.error('VERDICT_DOMAIN_SHADOWS_CORE', `domain verdict "${label}" shadows a core verdict`);
    }
  }

  const used = new Set<string>();
  for (const node of Object.values(template.nodes)) {
    checkGuardVerdictLabels(node, core, domainSet, used, d);
    checkGateOutcomesSubset(node, domainSet, used, d);
  }

  for (const label of domain) {
    if (!used.has(label)) d.warn('VERDICT_DECLARED_UNUSED', `domain verdict "${label}" is declared but never used`);
  }
}


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
