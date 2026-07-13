import type { RunnerManifest } from '../control-plane/run-profile-contract.js';

export const RUNNER_MANIFESTS: Readonly<Record<string, RunnerManifest>> = {
  'claude-code': {
    runnerId: 'claude-code',
    manifestVersion: '1',
    manifestDigest: 'sha256:bf86bbe413c12137354da15d319001ba12f1f8c7fad0862d29969b969ccaaaa5',
    stdoutParserId: 'claude-json',
    permissionStyleId: 'claude-permission-mode',
    declaredDefaultPermissionMode: 'default',
    capabilities: { structuredOutput: true, worktreeChanges: true },
    constraints: {
      allowedProviders: ['anthropic'],
      permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      modelParamKeys: ['maxTurns'],
    },
    executionFields: { command: 'claude' },
  },
  codex: {
    runnerId: 'codex',
    manifestVersion: '1',
    manifestDigest: 'sha256:0aef3f3d585202d3747b4b4c6eb45079dbc99e6c9d30a348f2078d8bce279d9a',
    stdoutParserId: 'codex-jsonl',
    permissionStyleId: 'codex-sandbox',
    declaredDefaultPermissionMode: 'read-only',
    capabilities: { structuredOutput: true, worktreeChanges: true },
    constraints: {
      allowedProviders: ['openai'],
      permissionModes: ['read-only', 'workspace-write'],
      modelParamKeys: ['maxTurns'],
    },
    executionFields: { command: 'codex' },
  },
};

export function runnerManifests(): Record<string, RunnerManifest> {
  return Object.fromEntries(
    Object.entries(RUNNER_MANIFESTS).map(([runnerId, manifest]) => [runnerId, {
      ...manifest,
      capabilities: { ...manifest.capabilities },
      constraints: {
        ...manifest.constraints,
        ...(manifest.constraints.allowedProviders ? { allowedProviders: [...manifest.constraints.allowedProviders] } : {}),
        ...(manifest.constraints.permissionModes ? { permissionModes: [...manifest.constraints.permissionModes] } : {}),
        ...(manifest.constraints.modelParamKeys ? { modelParamKeys: [...manifest.constraints.modelParamKeys] } : {}),
      },
      executionFields: { ...manifest.executionFields },
    }]),
  );
}
