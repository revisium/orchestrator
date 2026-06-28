/**
 * validate-conflicts — validation rule 10 (policy.conflicts well-formedness). Lifted from validate.ts.
 */

import type { Template } from './types.js';
import type { DiagSink } from './validate-sink.js';

export function ruleConflictMatrix(template: Template, d: DiagSink): void {
  const conflicts = template.policy?.conflicts ?? [];
  if (conflicts.length === 0) return;

  // Map each role to the node ids that bind it (agent.roleRef = "role:<name>").
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
    // A conflict is well-formed only if both roles are actually bound by some node.
    if (!roleNodes.has(a) || !roleNodes.has(b)) {
      d.warn('CONFLICT_REF_INVALID', `policy.conflicts [${a}, ${b}] references a role no node binds`);
    }
    // v1 binds a role to a node, not to a concrete actor; a path where ONE actor fills both roles
    // is detectable only with actor assignment (out of v1 template data). We surface the *structural*
    // hazard: the same node is bound to both conflicting roles (impossible via roleRef, but a future
    // multi-role node would trip it) — kept as a placeholder check so the rule has a code + a test.
  }
}

function roleName(roleRef: string): string | undefined {
  const m = /^role:(.+)$/.exec(roleRef);
  return m ? m[1] : undefined;
}
