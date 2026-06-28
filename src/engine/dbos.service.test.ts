/**
 * Unit tests for DbosService (E6, E9, F4).
 * Mocks the DBOS static class to avoid needing a live database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { resolveShutdownDrainTimeoutMs, SHUTDOWN_DRAIN_TIMEOUT_MS } from './dbos.service.js';

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
const origSetEvent = DBOS.setEvent.bind(DBOS);
const origGetEvent = DBOS.getEvent.bind(DBOS);
const origWriteStream = DBOS.writeStream.bind(DBOS);
const origCloseStream = DBOS.closeStream.bind(DBOS);
const origReadStream = DBOS.readStream.bind(DBOS);

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).setEvent = async () => undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).getEvent = async () => null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).writeStream = async () => undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).closeStream = async () => undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).readStream = async function* () {};

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).setEvent = origSetEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).getEvent = origGetEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).writeStream = origWriteStream;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).closeStream = origCloseStream;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).readStream = origReadStream;
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

test('DbosService: setConfig disables the DBOS admin server (no port 3001 bind)', async () => {
  const recorded = patchDbos({});
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    assert.equal(recorded.config?.runAdminServer, false);
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

test('DbosService: concurrent launch() calls share one DBOS.launch()', async () => {
  let releaseLaunch!: () => void;
  let launchCallCount = 0;
  patchDbos({
    launch: async () => {
      launchCallCount += 1;
      await new Promise<void>((resolve) => { releaseLaunch = resolve; });
    },
  });
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    svc.setConfig('postgresql://revisium:password@localhost:15440/dbos');
    const firstLaunch = svc.launch();
    const secondLaunch = svc.launch();
    assert.equal(launchCallCount, 1, 'only the first concurrent caller may call DBOS.launch()');
    releaseLaunch();
    await Promise.all([firstLaunch, secondLaunch]);
    assert.equal(launchCallCount, 1, 'concurrent callers must await the shared launch promise');
    await svc.shutdown();
  } finally {
    restoreDbos();
  }
});

test('DbosService: registerQueue rejects conflicting duplicate options', async () => {
  patchDbos({});
  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();
    const queueName = `test-queue-${process.pid}`;
    svc.registerQueue(queueName, { concurrency: 2, workerConcurrency: 1 });
    assert.doesNotThrow(() => svc.registerQueue(queueName, { concurrency: 2, workerConcurrency: 1 }));
    assert.throws(
      () => svc.registerQueue(queueName, { concurrency: 3, workerConcurrency: 1 }),
      /already registered with different options/,
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

test('resolveShutdownDrainTimeoutMs: unset/blank keeps the 8 s production default', () => {
  assert.equal(resolveShutdownDrainTimeoutMs({}), SHUTDOWN_DRAIN_TIMEOUT_MS);
  assert.equal(resolveShutdownDrainTimeoutMs({ REVO_SHUTDOWN_DRAIN_TIMEOUT_MS: '' }), SHUTDOWN_DRAIN_TIMEOUT_MS);
  assert.equal(resolveShutdownDrainTimeoutMs({ REVO_SHUTDOWN_DRAIN_TIMEOUT_MS: '  ' }), SHUTDOWN_DRAIN_TIMEOUT_MS);
});

test('resolveShutdownDrainTimeoutMs: a positive value overrides the default (e2e fast path)', () => {
  assert.equal(resolveShutdownDrainTimeoutMs({ REVO_SHUTDOWN_DRAIN_TIMEOUT_MS: '100' }), 100);
});

test('resolveShutdownDrainTimeoutMs: non-positive or non-numeric falls back to the default (no footgun)', () => {
  // shutdown() reads <=0 as "disable the bound" (await the full drain), so the env knob must never
  // resolve to 0/negative — those fall back to the safe 8 s default instead of hanging teardown.
  for (const bad of ['0', '-5', 'abc', 'NaN', 'Infinity']) {
    assert.equal(
      resolveShutdownDrainTimeoutMs({ REVO_SHUTDOWN_DRAIN_TIMEOUT_MS: bad }),
      SHUTDOWN_DRAIN_TIMEOUT_MS,
      `${bad} must fall back to the default`,
    );
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

test('DbosService streams: wrappers delegate to DBOS communication primitives', async () => {
  patchDbos({});
  const writes: unknown[][] = [];
  let closedKey = '';
  let readArgs: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).writeStream = async (...args: unknown[]) => { writes.push(args); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).closeStream = async (key: string) => { closedKey = key; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DBOS as any).readStream = async function* (...args: unknown[]) {
    readArgs = args;
    yield { cursor: 'c1' };
  };

  try {
    const { DbosService } = await import('./dbos.service.js');
    const svc = new DbosService();

    await svc.writeStream('agent-output', { cursor: 'c1' });
    await svc.closeStream('agent-output');
    const read: unknown[] = [];
    for await (const event of svc.readStream('run-1', 'agent-output')) {
      read.push(event);
    }

    assert.deepEqual(writes, [['agent-output', { cursor: 'c1' }]]);
    assert.equal(closedKey, 'agent-output');
    assert.deepEqual(readArgs, ['run-1', 'agent-output']);
    assert.deepEqual(read, [{ cursor: 'c1' }]);
  } finally {
    restoreDbos();
  }
});
