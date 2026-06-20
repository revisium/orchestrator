import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemResolver } from './system.resolver.js';
import type { SystemApiService } from '../../../features/system/system-api.service.js';

test('SystemResolver.status delegates to SystemApiService', async () => {
  const expected = {
    daemon: {
      running: false,
      healthy: false,
      pid: null,
      baseUrl: null,
      httpPort: null,
      pgPort: null,
    },
    project: {
      org: 'admin',
      project: 'control-plane',
      branch: 'master',
      dataDir: '/tmp/revo',
    },
  };
  let calls = 0;
  const api = {
    async status() {
      calls += 1;
      return expected;
    },
  } as unknown as SystemApiService;

  const resolver = new SystemResolver(api);

  assert.deepEqual(await resolver.status(), expected);
  assert.equal(calls, 1);
});
