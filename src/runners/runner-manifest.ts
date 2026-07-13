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
    manifestDigest: 'sha256:621c0adb53a6562e095f000ee2d19afaa875d33f970e10e8ed682877ca54f6c6',
    stdoutParserId: 'codex-jsonl',
    permissionStyleId: 'codex-sandbox',
    declaredDefaultPermissionMode: 'read-only',
    capabilities: { structuredOutput: true, worktreeChanges: true },
    constraints: {
      allowedProviders: ['openai'],
      permissionModes: ['read-only', 'workspace-write'],
      modelParamKeys: [],
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
