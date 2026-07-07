import test from 'node:test';
import assert from 'node:assert/strict';

test('HostLifecycle: dbosDatabaseUrl uses the provided embedded Postgres port', async () => {
  const { dbosDatabaseUrl } = await import('../storage/revo-database.js');

  const provenPort = 15441;
  const url = dbosDatabaseUrl(provenPort);
  assert.ok(
    url.includes(`:${provenPort}/`),
    `URL must contain the proven port ${provenPort}: ${url}`,
  );
  assert.ok(!url.includes(':15440/'), 'URL must NOT contain the preferred fallback port 15440');
});

test('HostLifecycle: onApplicationShutdown only shuts down DBOS', async () => {
  let unexpectedStopCalled = false;
  let shutdownCalled = false;

  const fakeSvc = {
    setConfig: () => {},
    launch: async () => {},
    shutdown: async () => { shutdownCalled = true; },
    killTree: () => { unexpectedStopCalled = true; },
    removeRuntime: () => { unexpectedStopCalled = true; },
  } as unknown as import('../engine/dbos.service.js').DbosService;

  const { HostLifecycle } = await import('./host.lifecycle.js');
  const lc = new HostLifecycle(fakeSvc);
  await lc.onApplicationShutdown();

  assert.ok(shutdownCalled, 'dbosService.shutdown() must be called');
  assert.ok(!unexpectedStopCalled, 'process/file cleanup helpers must not be called by HostLifecycle');
});
