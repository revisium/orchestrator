import type { ControlPlaneRow } from '../control-plane/data-access.js';
import type { Role } from '../control-plane/definitions.js';
import type { AgentBinding } from '../control-plane/run-profile-contract.js';
import type { Step } from '../control-plane/steps.js';

export function fakeRow(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  return { rowId, data, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

export function makeRole(name: string, overrides: Partial<Role> = {}): Role {
  return {
    name,
    systemPrompt: `You are the ${name}.`,
    allowedTools: [],
    scopeRules: {},
    ...overrides,
  };
}

export const TEST_PROFILE: AgentBinding = {
  runnerId: 'claude-code',
  provider: 'test',
  modelId: 'test-model',
  modelParams: {},
};

export const BASE_STEP: Step = {
  id: 'step-1',
  taskId: 'task-1',
  runId: 'run-1',
  role: 'architect',
  kind: 'plan_run',
  status: 'claimed',
  input: null,
  output: null,
  runAfter: '',
  attemptCount: 0,
  maxAttempts: 3,
  priority: 0,
  leaseOwner: 'worker-1',
  leaseExpiresAt: '',
  deadReason: '',
};
