import { CORE_VERDICTS, JOIN_VERDICT_REDUCER_KINDS } from './types.js';
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
    checkJoinVerdictReducer(node, domainSet, used, d);
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

/** 9e — a join verdictReducer forwards only declared domain labels. */
function checkJoinVerdictReducer(node: Node, domainSet: Set<string>, used: Set<string>, d: DiagSink): void {
  if (node.kind !== 'join' || node.verdictReducer === undefined) return;
  const reducer = node.verdictReducer as unknown;
  if (!isRecord(reducer)) {
    d.error('VERDICT_REDUCER_BAD_SHAPE', `join ${node.id} verdictReducer must be an object`, {
      nodeId: node.id,
      path: 'verdictReducer',
    });
    return;
  }
  const kind = reducer.kind;
  if (typeof kind !== 'string' || !(JOIN_VERDICT_REDUCER_KINDS as readonly string[]).includes(kind)) {
    d.error('VERDICT_REDUCER_BAD_KIND', `join ${node.id} verdictReducer kind "${String(kind)}" is not allowed`, {
      nodeId: node.id,
      path: 'verdictReducer.kind',
    });
    return;
  }
  if (kind !== 'allIn') return;

  const pass = reducer.pass;
  const passVerdict = reducer.passVerdict;
  const failVerdict = reducer.failVerdict;
  if (
    !Array.isArray(pass) ||
    !pass.every((label): label is string => typeof label === 'string') ||
    typeof passVerdict !== 'string' ||
    typeof failVerdict !== 'string'
  ) {
    d.error('VERDICT_REDUCER_BAD_SHAPE', `join ${node.id} verdictReducer allIn shape is invalid`, {
      nodeId: node.id,
      path: 'verdictReducer',
    });
    return;
  }

  const labels = [...pass, passVerdict, failVerdict];
  for (const label of labels) {
    used.add(label);
    if (!domainSet.has(label)) {
      d.error('VERDICT_UNDECLARED', `join ${node.id} verdictReducer uses undeclared verdict "${label}"`, {
        nodeId: node.id,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
