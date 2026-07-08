export type E2eRunProfile = {
  schemaVersion: 'run-profile/v1';
  topology: { stages: Record<string, { mode: 'single' }> };
  bindings: {
    slots: Record<string, { runnerId: string; modelLevel: string }>;
  };
};

const DEFAULT_AGENT_ROLES = [
  'orchestrator',
  'analyst',
  'reviewer',
  'developer',
  'watcher',
  'triager',
] as const;

const FIXTURE_AGENT_ROLES = [
  ...DEFAULT_AGENT_ROLES,
  'architect',
  'deploy-watcher',
  'developer-backend',
  'developer-frontend',
  'knowledge-engineer',
  'pr-poller',
  'pr-watcher',
  'qa-backend',
  'qa-frontend',
] as const;

function stubProfile(
  agentRoles: readonly string[],
  scriptRoles: readonly string[] = [],
): E2eRunProfile {
  const slots: E2eRunProfile['bindings']['slots'] = {};
  for (const role of agentRoles) {
    slots[`role:${role}`] = { runnerId: 'stub-agent', modelLevel: 'standard' };
  }
  for (const role of scriptRoles) {
    slots[`role:${role}`] = { runnerId: 'stub-agent', modelLevel: 'standard' };
  }
  return {
    schemaVersion: 'run-profile/v1',
    topology: { stages: {} },
    bindings: { slots },
  };
}

export function stubDefaultAgentProfile(): E2eRunProfile {
  return stubProfile(DEFAULT_AGENT_ROLES);
}

export function stubDefaultFullProfile(): E2eRunProfile {
  return stubProfile(DEFAULT_AGENT_ROLES, ['integrator']);
}

export function stubFixtureAgentProfile(): E2eRunProfile {
  return stubProfile(FIXTURE_AGENT_ROLES);
}

export function stubFixtureFullProfile(): E2eRunProfile {
  return stubProfile(FIXTURE_AGENT_ROLES, ['integrator', 'merger']);
}

export function stubFixtureIntegratorProfile(): E2eRunProfile {
  return stubProfile([], ['integrator', 'merger']);
}
