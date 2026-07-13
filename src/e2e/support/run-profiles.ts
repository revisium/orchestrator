type E2eRunProfileSlotBinding = {
  runnerId: string;
  provider: string;
  modelId: string;
  modelParams: Record<string, unknown>;
  permissionMode?: string;
  timeoutMs?: number;
} | {
  accounts: Record<string, string>;
};

export type E2eRunProfile = {
  schemaVersion: 'run-profile/v1';
  topology: { stages: Record<string, { mode: 'single' | 'consensus'; branches?: number }> };
  bindings: {
    slots: Record<string, E2eRunProfileSlotBinding>;
  };
};

const DEFAULT_AGENT_ROLES = [
  'analyst',
  'reviewer',
  'developer',
  'triager',
] as const;

const FIXTURE_AGENT_ROLES = [
  'analyst',
  'developer',
  'reviewer',
  'triager',
  'watcher',
  'deploy-watcher',
  'developer-backend',
  'developer-frontend',
  'knowledge-engineer',
  'pr-poller',
  'pr-watcher',
  'qa-backend',
  'qa-frontend',
] as const;

const FIXTURE_PIPELINE_BINDINGS: Record<string, { roles: readonly string[]; scripts: readonly string[] }> = {
  'analysis-only': { roles: ['analyst'], scripts: [] },
  bugfix: { roles: ['analyst', 'developer', 'watcher'], scripts: ['integrator'] },
  'feature-development': {
    roles: ['analyst', 'developer', 'reviewer', 'triager'],
    scripts: ['cleanupWorktree', 'confirmMerge', 'integrator', 'mergeApproveReverify', 'mergeReadiness', 'mergeRecheck', 'pollPr', 'questionReviewIntegrator', 'respondThreads', 'reviewIntegrator'],
  },
  'feature-development-dd': { roles: ['analyst', 'developer', 'reviewer', 'watcher'], scripts: ['integrator'] },
  'feature-pr-poll': { roles: ['analyst', 'developer', 'reviewer', 'pr-poller'], scripts: ['integrator'] },
  'feature-pr-watch': { roles: ['analyst', 'developer', 'reviewer', 'pr-watcher'], scripts: ['integrator'] },
  'local-change': { roles: ['developer'], scripts: [] },
  'method-development': { roles: ['knowledge-engineer'], scripts: [] },
  'parallel-review-consensus-e2e': { roles: ['reviewer'], scripts: [] },
  'post-merge-qa': { roles: ['deploy-watcher', 'qa-backend'], scripts: [] },
};

function stubProfile(
  agentRoles: readonly string[],
  scriptNodes: readonly string[] = [],
): E2eRunProfile {
  const slots: E2eRunProfile['bindings']['slots'] = {};
  for (const role of agentRoles) {
    slots[`role:${role}`] = {
      runnerId: 'codex',
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
      modelParams: {},
      permissionMode: role.startsWith('developer') ? 'workspace-write' : 'read-only',
    };
  }
  for (const nodeId of scriptNodes) {
    slots[`node:${nodeId}`] = { accounts: { github: 'profile-bot' } };
  }
  return {
    schemaVersion: 'run-profile/v1',
    topology: { stages: {} },
    bindings: { slots },
  };
}

export function stubDefaultAgentProfile(pipelineId = 'feature-development'): E2eRunProfile {
  const graph = pipelineId === 'local-change'
    ? { roles: ['developer'], scripts: [] }
    : pipelineId === 'analysis-only'
      ? { roles: ['analyst'], scripts: [] }
      : { roles: DEFAULT_AGENT_ROLES, scripts: ['integrator'] };
  return stubProfile(graph.roles, graph.scripts);
}

export function stubFixtureAgentProfile(pipelineId = 'feature-development'): E2eRunProfile {
  const graph = FIXTURE_PIPELINE_BINDINGS[pipelineId] ?? { roles: FIXTURE_AGENT_ROLES, scripts: [] };
  return stubProfile(graph.roles, graph.scripts);
}

/** Full materialized fixture profile, including every agent and script obligation for the pipeline. */
export function stubFixturePipelineProfile(pipelineId = 'feature-pr-watch'): E2eRunProfile {
  return stubFixtureAgentProfile(pipelineId);
}
