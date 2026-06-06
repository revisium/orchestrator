/**
 * Unit tests for DbosService (E6, E9, F4).
 * Mocks the DBOS static class to avoid needing a live database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';

// Store original methods for restoration.
const origSetConfig = DBOS.setConfig.bind(DBOS);
const origLaunch = DBOS.launch.bind(DBOS);
const origShutdown = DBOS.shutdown.bind(DBOS);
const origGetWorkflowStatus = DBOS.getWorkflowStatus.bind(DBOS);
const origRetrieveWorkflow = DBOS.retrieveWorkflow.bind(DBOS);
const origRegisterWorkflow = DBOS.registerWorkflow;
const origRegisterStep = DBOS.registerStep;

type ConfigArg = Parameters<typeof DBOS.setConfig>[0];

function patchDbos(overrides: {
  launch?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}) {
  const recorded = {
    config: undefined as ConfigArg | undefined,
    launchCallCount: 0,
    shutdownCallCount: 0,
  };

  // registerWorkflow / registerStep return the fn unchanged (identity) for test isolation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).registerWorkflow = (fn: unknown) => fn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).registerStep = (fn: unknown) => fn;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).setConfig = (cfg: ConfigArg) => { recorded.config = cfg; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).launch = overrides.launch ?? (async () => { recorded.launchCallCount += 1; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).shutdown = overrides.shutdown ?? (async () => { recorded.shutdownCallCount += 1; });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).getWorkflowStatus = async (_id: string) => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).retrieveWorkflow = (_id: string) => ({
    getResult: async () => null,
    getStatus: async () => null,
    workflowID: _id,
  });

  return recorded;
}

function restoreDbos() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).setConfig = origSetConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).launch = origLaunch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).shutdown = origShutdown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).getWorkflowStatus = origGetWorkflowStatus;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).retrieveWorkflow = origRetrieveWorkflow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).registerWorkflow = origRegisterWorkflow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).registerStep = origRegisterStep;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('DbosService: setConfig passes systemDatabaseUrl field (confirmed SDK field name — F4)', async () => {
  const recorded = patchDbos({});
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    assert.ok(recorded.config, 'config must be set');
    assert.ok(
      recorded.config !== undefined && 'systemDatabaseUrl' in recorded.config,
      'must use systemDatabaseUrl field (SDK-4.x confirmed)',
    );
    assert.equal(
      recorded.config?.systemDatabaseUrl,
      'postgresql://revisium:password@localhost:15440/dbos',
    );
  } finally {
    restoreDbos();
  }
});

test('DbosService: launch() is idempotent — second call is a no-op (E6)', async () => {
  let launchCallCount = 0;
  patchDbos({ launch: async () => { launchCallCount += 1; } });
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    await svc.launch();
    await svc.launch();
    assert.equal(
      launchCallCount,
      1,
      'DBOS.launch() must be called exactly once despite two svc.launch() calls',
    );
  } finally {
    restoreDbos();
  }
});

test('DbosService: shutdown() before launch() is a no-op (E9)', async () => {
  let shutdownCallCount = 0;
  patchDbos({ shutdown: async () => { shutdownCallCount += 1; } });
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    await svc.shutdown(); // never launched
    assert.equal(
      shutdownCallCount,
      0,
      'DBOS.shutdown() must NOT be called when service was never launched',
    );
  } finally {
    restoreDbos();
  }
});

test('DbosService: shutdown() after launch() calls DBOS.shutdown()', async () => {
  let shutdownCallCount = 0;
  patchDbos({ shutdown: async () => { shutdownCallCount += 1; } });
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    await svc.launch();
    await svc.shutdown();
    assert.equal(shutdownCallCount, 1, 'DBOS.shutdown() must be called once after launch');
  } finally {
    restoreDbos();
  }
});
