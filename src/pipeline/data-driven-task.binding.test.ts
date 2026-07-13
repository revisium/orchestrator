import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePinnedAgentBinding } from './data-driven-task.workflow.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';

const roleBinding = { nodeId: 'developer', roleId: 'developer', modelId: 'role-model' } as ResolvedAgentBinding;
const nodeBinding = { nodeId: 'reviewer', roleId: 'developer', modelId: 'node-model' } as ResolvedAgentBinding;

test('workflow resolves the pinned agent binding by node identity', () => {
  const bindings = new Map([
    ['role:developer', roleBinding],
    ['node:reviewer', nodeBinding],
  ]);

  assert.equal(resolvePinnedAgentBinding(bindings, 'reviewer'), nodeBinding);
  assert.throws(
    () => resolvePinnedAgentBinding(bindings, 'missing'),
    (error: unknown) => (error as { message?: string }).message?.startsWith('execution_plan_binding_unresolved:') === true,
  );
});
