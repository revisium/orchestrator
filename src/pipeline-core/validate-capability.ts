

import type { Template } from './types.js';
import type { DiagSink } from './validate-sink.js';

const CAPABILITY_REF_PATTERN = /^(role|script):[A-Za-z][A-Za-z0-9_-]*$/;

export function ruleCapabilityRefs(template: Template, d: DiagSink): void {
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent') {
      if (!CAPABILITY_REF_PATTERN.test(node.roleRef) || !node.roleRef.startsWith('role:')) {
        d.error('CAPABILITY_REF_SHAPE', `agent ${node.id} roleRef "${node.roleRef}" is malformed`, {
          nodeId: node.id,
        });
      }
    } else if (node.kind === 'script') {
      if (!CAPABILITY_REF_PATTERN.test(node.scriptRef) || !node.scriptRef.startsWith('script:')) {
        d.error('CAPABILITY_REF_SHAPE', `script ${node.id} scriptRef "${node.scriptRef}" is malformed`, {
          nodeId: node.id,
        });
      }
    }
  }
}
