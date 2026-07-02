import { createHash } from 'node:crypto';
import type { AgentNode, ConsumesRef, JoinMode, JoinVerdictReducer, MergeReducer, Node, Template } from './types.js';

export type TopologyProfile = {
  profileId: string;
  pipelineId: string;
  toggles: ConsensusToggle[];
};

export type ConsensusToggle = {
  target: string;
  baseName?: string;
  fanout: { branches: number };
  join: {
    joinMode: JoinMode;
    verdictReducer?: JoinVerdictReducer;
    merge?: Record<string, MergeReducer>;
  };
};

export const MATERIALIZE_CODES = [
  'MATERIALIZE_UNKNOWN_PROFILE',
  'MATERIALIZE_UNKNOWN_PROFILE_KEY',
  'MATERIALIZE_TOGGLE_NOT_ALLOWLISTED',
  'MATERIALIZE_TOGGLE_UNRESOLVED',
  'MATERIALIZE_TOGGLE_NOT_AGENT',
  'MATERIALIZE_TOGGLE_DUPLICATE_TARGET',
  'MATERIALIZE_TOGGLE_INVALID_BRANCH_COUNT',
] as const;
export type MaterializeCode = (typeof MATERIALIZE_CODES)[number];

export type MaterializeDiagnostic = {
  code: MaterializeCode;
  severity: 'error';
  message: string;
  target?: string;
};

export type MaterializeResult = {
  template: Template;
  materializedTemplateHash: string;
  diagnostics: MaterializeDiagnostic[];
};

const PROFILE_KEYS = new Set<string>(['profileId', 'pipelineId', 'toggles']);
const TOGGLE_KEYS = new Set<string>(['target', 'baseName', 'fanout', 'join']);

export function materializeTemplate(
  base: Template,
  profile: TopologyProfile,
  opts: { allowlist: string[] },
): MaterializeResult {
  const diagnostics: MaterializeDiagnostic[] = [];

  for (const key of Object.keys(profile as Record<string, unknown>)) {
    if (!PROFILE_KEYS.has(key)) {
      diagnostics.push({ code: 'MATERIALIZE_UNKNOWN_PROFILE_KEY', severity: 'error', message: `TopologyProfile has unknown key "${key}"` });
    }
  }

  if (profile.pipelineId !== base.pipelineId) {
    diagnostics.push({
      code: 'MATERIALIZE_UNKNOWN_PROFILE',
      severity: 'error',
      message: `profile pipelineId "${profile.pipelineId}" does not match base pipelineId "${base.pipelineId}"`,
    });
  }

  for (const toggle of profile.toggles ?? []) {
    for (const key of Object.keys(toggle as Record<string, unknown>)) {
      if (!TOGGLE_KEYS.has(key)) {
        diagnostics.push({
          code: 'MATERIALIZE_UNKNOWN_PROFILE_KEY',
          severity: 'error',
          message: `ConsensusToggle has unknown key "${key}"`,
          target: toggle.target,
        });
      }
    }
  }

  if (diagnostics.length > 0) {
    const template = structuredClone(base);
    return { template, materializedTemplateHash: hashTemplate(template), diagnostics };
  }

  if (!profile.toggles || profile.toggles.length === 0) {
    const template = structuredClone(base);
    return { template, materializedTemplateHash: hashTemplate(template), diagnostics };
  }

  const seenTargets = new Set<string>();
  for (const toggle of profile.toggles) {
    if (seenTargets.has(toggle.target)) {
      diagnostics.push({
        code: 'MATERIALIZE_TOGGLE_DUPLICATE_TARGET',
        severity: 'error',
        message: `toggle target "${toggle.target}" is targeted by more than one toggle`,
        target: toggle.target,
      });
      continue;
    }
    seenTargets.add(toggle.target);

    if (!opts.allowlist.includes(toggle.target)) {
      diagnostics.push({
        code: 'MATERIALIZE_TOGGLE_NOT_ALLOWLISTED',
        severity: 'error',
        message: `toggle target "${toggle.target}" is not in the allowlist`,
        target: toggle.target,
      });
      continue;
    }

    const targetNode = base.nodes[toggle.target];
    if (!targetNode) {
      diagnostics.push({
        code: 'MATERIALIZE_TOGGLE_UNRESOLVED',
        severity: 'error',
        message: `toggle target "${toggle.target}" does not exist in the base template`,
        target: toggle.target,
      });
      continue;
    }

    if (targetNode.kind !== 'agent') {
      diagnostics.push({
        code: 'MATERIALIZE_TOGGLE_NOT_AGENT',
        severity: 'error',
        message: `toggle target "${toggle.target}" is kind "${targetNode.kind}", expected "agent"`,
        target: toggle.target,
      });
      continue;
    }

    const n = toggle.fanout.branches;
    if (!Number.isInteger(n) || n < 2 || n > BRANCH_NAMES.length) {
      diagnostics.push({
        code: 'MATERIALIZE_TOGGLE_INVALID_BRANCH_COUNT',
        severity: 'error',
        message: `toggle target "${toggle.target}" fanout.branches must be an integer between 2 and ${BRANCH_NAMES.length}, got ${n}`,
        target: toggle.target,
      });
    }
  }

  if (diagnostics.length > 0) {
    const template = structuredClone(base);
    return { template, materializedTemplateHash: hashTemplate(template), diagnostics };
  }

  let nodes: Record<string, Node> = structuredClone(base.nodes);
  for (const toggle of profile.toggles) {
    nodes = applyToggle(nodes, toggle);
  }

  const template: Template = { ...structuredClone(base), nodes };
  return { template, materializedTemplateHash: hashTemplate(template), diagnostics };
}

const BRANCH_NAMES = ['Primary', 'Secondary', 'Tertiary', 'Quaternary', 'Quinary', 'Senary', 'Septenary', 'Octonary'];
const BRANCH_IDS = ['primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary', 'octonary'];

function applyToggle(nodes: Record<string, Node>, toggle: ConsensusToggle): Record<string, Node> {
  const collapsed = nodes[toggle.target] as AgentNode;
  const base = toggle.baseName ?? toggle.target;
  const n = toggle.fanout.branches;
  const branchSuffixes = BRANCH_NAMES.slice(0, n);
  const branchIds = BRANCH_IDS.slice(0, n);

  const fanoutId = `${base}Fanout`;
  const joinId = `${base}Join`;

  const fanoutNode: Node = {
    id: fanoutId,
    kind: 'parallel',
    branches: branchIds.map((bid, i) => ({ id: bid, entry: `${base}${branchSuffixes[i]}` })),
    join: joinId,
  };

  // Clone every field of the collapsed node (onFailure/resultSchema/produces/consumes and also
  // catch/escalateTo/incrementCounters, which the original per-field copy silently dropped) —
  // each branch is a full parallel copy of the collapsed agent, routed to the join instead.
  const branchNodes: Node[] = branchSuffixes.map((suffix) => {
    const branchNode: AgentNode = {
      ...structuredClone(collapsed),
      id: `${base}${suffix}`,
      next: joinId,
    };
    return branchNode;
  });

  const joinNode: Node = {
    id: joinId,
    kind: 'join',
    joinMode: toggle.join.joinMode,
    ...(toggle.join.verdictReducer !== undefined && { verdictReducer: toggle.join.verdictReducer }),
    ...(toggle.join.merge !== undefined && { merge: toggle.join.merge }),
    next: collapsed.next,
  };

  const result: Record<string, Node> = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (id === toggle.target) continue;
    result[id] = rewireNode(structuredClone(node), toggle.target, fanoutId, branchIds, base);
  }

  result[fanoutId] = fanoutNode;
  for (const bn of branchNodes) result[bn.id] = bn;
  result[joinId] = joinNode;

  return result;
}

function rewireNode(node: Node, collapsedId: string, fanoutId: string, branchIds: string[], base: string): Node {
  rewireEdges(node, collapsedId, fanoutId);
  if ((node.kind === 'agent' || node.kind === 'script') && node.consumes) {
    node.consumes = rewireConsumes(node.consumes, collapsedId, branchIds, base);
  }
  return node;
}

function rewireEdges(node: Node, from: string, to: string): void {
  const n = node as Record<string, unknown>;
  if (n['next'] === from) n['next'] = to;

  const branches = n['branches'];
  if (Array.isArray(branches)) {
    for (const branch of branches as Array<Record<string, unknown>>) {
      if (branch['goto'] === from) branch['goto'] = to;
      if (branch['default'] === from) branch['default'] = to;
    }
  }

  const catchArr = n['catch'];
  if (Array.isArray(catchArr)) {
    for (const entry of catchArr as Array<Record<string, unknown>>) {
      if (entry['goto'] === from) entry['goto'] = to;
    }
  }

  if (n['join'] === from) n['join'] = to;
}

function rewireConsumes(consumes: ConsumesRef[], collapsedId: string, branchIds: string[], base: string): ConsumesRef[] {
  const result: ConsumesRef[] = [];
  for (const ref of consumes) {
    if (ref.node !== collapsedId) {
      result.push(ref);
      continue;
    }
    for (let i = 0; i < branchIds.length; i++) {
      result.push({
        ...ref,
        node: `${base}${BRANCH_NAMES[i]}`,
        as: `${ref.as}${BRANCH_NAMES[i]}`,
      });
    }
  }
  return result;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashTemplate(template: Template): string {
  return createHash('sha256').update(stableStringify(template)).digest('hex');
}
