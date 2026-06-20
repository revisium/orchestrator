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
const origSend = DBOS.send.bind(DBOS);
const origRecv = DBOS.recv.bind(DBOS);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).send = origSend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).recv = origRecv;
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

test('DbosService: setConfig forwards logLevel for stdio-safe host modes', async () => {
  const recorded = patchDbos({});
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos', { logLevel: 'warn' });
    assert.equal(recorded.config?.logLevel, 'warn');
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
    await svc.shutdown();
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

test('DbosService: shutdown() detaches when DBOS.shutdown() hangs past the drain timeout (0008 #3)', async () => {
  // Simulate a workflow parked at a human gate: DBOS.shutdown() never resolves.
  let drainSettled = false;
  patchDbos({ shutdown: () => new Promise<void>(() => { /* never resolves */ }).then(() => { drainSettled = true; }) });
  const origWarn = console.warn;
  let warned = '';
  console.warn = (msg?: unknown) => { warned = String(msg); };
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    await svc.launch();
    const started = Date.now();
    // Pass a short bound so the test does not wait the full default.
    await svc.shutdown(50);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `shutdown must detach quickly, took ${elapsed}ms`);
    assert.equal(drainSettled, false, 'the hung drain must NOT have resolved');
    assert.match(warned, /drain exceeded/, 'must warn that it detached without draining');
  } finally {
    console.warn = origWarn;
    restoreDbos();
  }
});

test('DbosService: shutdown() is a no-op on the second call after a detach (0008 #3)', async () => {
  let shutdownCallCount = 0;
  patchDbos({ shutdown: async () => { shutdownCallCount += 1; } });
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    await svc.launch();
    await svc.shutdown();
    await svc.shutdown();
    assert.equal(shutdownCallCount, 1, 'DBOS.shutdown() must be called exactly once');
  } finally {
    restoreDbos();
  }
});

// ── 0004 G9: signal reorder assertion + awaitDecision deadline ────────────────

test('DbosService.signal: wrapper canonical order (workflowId,topic,payload,idemKey) reorders to raw DBOS.send(workflowId,payload,topic,idemKey) (G9)', async () => {
  patchDbos({});
  // Capture DBOS.send args.
  let sendArgs: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).send = async (...args: unknown[]) => { sendArgs = args; };

  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();

    const workflowId = 'wf-123';
    const topic = 'plan';
    const payload = { decision: 'approve' };
    const idempotencyKey = 'inbox_abc';

    // Call with WRAPPER canonical order: (workflowId, topic, payload, idempotencyKey).
    await svc.signal(workflowId, topic, payload, idempotencyKey);

    // DBOS.send receives RAW order: (destinationID, message, topic, idempotencyKey).
    // The wrapper REORDERS: topic ↔ payload are swapped inside signal().
    assert.equal(sendArgs[0], workflowId, 'arg0 = workflowId (destinationID)');
    assert.equal(sendArgs[1], payload, 'arg1 = payload (message) — WRAPPER REORDERS: topic↔payload');
    assert.equal(sendArgs[2], topic, 'arg2 = topic — WRAPPER REORDERS: was arg1 in wrapper');
    assert.equal(sendArgs[3], idempotencyKey, 'arg3 = idempotencyKey');
  } finally {
    restoreDbos();
  }
});

test('DbosService.awaitDecision: passes topic and far-future deadlineEpochMS to DBOS.recv (G5)', async () => {
  patchDbos({});
  let recvArgs: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).recv = async (...args: unknown[]) => { recvArgs = args; return null; };

  try {
    const { DbosService, GATE_DEADLINE_EPOCH_MS } = await import('./dbos.service.js');
    const svc = new DbosService();

    await svc.awaitDecision('plan');

    assert.equal(recvArgs[0], 'plan', 'recv arg0 must be the topic');
    const opts = recvArgs[1] as Record<string, unknown>;
    assert.ok(opts && typeof opts === 'object', 'recv arg1 must be the options object');
    assert.equal(opts.deadlineEpochMS, GATE_DEADLINE_EPOCH_MS, 'deadlineEpochMS must equal GATE_DEADLINE_EPOCH_MS');
    // Verify the constant value matches the spec (year 2100).
    assert.equal(GATE_DEADLINE_EPOCH_MS, 4102444800000, 'GATE_DEADLINE_EPOCH_MS must be 4102444800000 (year 2100)');
  } finally {
    restoreDbos();
  }
});

test('DbosService.signal: idempotencyKey is optional — undefined not passed when omitted', async () => {
  patchDbos({});
  let sendArgs: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).send = async (...args: unknown[]) => { sendArgs = args; };

  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();

    await svc.signal('wf-id', 'plan', { decision: 'approve' });
    // arg3 is idempotencyKey (undefined when not passed) — DBOS accepts undefined.
    assert.equal(sendArgs[3], undefined, 'idempotencyKey must be undefined when not supplied');
  } finally {
    restoreDbos();
  }
});
