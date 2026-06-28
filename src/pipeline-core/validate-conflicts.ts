

import type { Template } from './types.js';
import type { DiagSink } from './validate-sink.js';

export function ruleConflictMatrix(template: Template, d: DiagSink): void {
  const conflicts = template.policy?.conflicts ?? [];
  if (conflicts.length === 0) return;

  const roleNodes = new Map<string, string[]>();
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent') {
      const role = roleName(node.roleRef);
      if (role) (roleNodes.get(role) ?? roleNodes.set(role, []).get(role)!).push(node.id);
    }
  }

  for (const pair of conflicts) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((r) => typeof r !== 'string')) {
      d.error('CONFLICT_REF_INVALID', `policy.conflicts entry ${JSON.stringify(pair)} is not a [roleA, roleB] pair`);
      continue;
    }
    const [a, b] = pair;
    if (!roleNodes.has(a) || !roleNodes.has(b)) {
      d.warn('CONFLICT_REF_INVALID', `policy.conflicts [${a}, ${b}] references a role no node binds`);
    }
  }
}

function roleName(roleRef: string): string | undefined {
  const m = /^role:(.+)$/.exec(roleRef);
  return m ? m[1] : undefined;
}
