import test from 'node:test';
import assert from 'node:assert/strict';
import { Linter, type Rule } from 'eslint';

async function loadRule(): Promise<Rule.RuleModule> {
  const url = new URL('../../../eslint-local-rules/test-architecture-boundaries.js', import.meta.url);
  const loaded = await import(url.href) as { default: Rule.RuleModule };
  return loaded.default;
}

async function verify(filename: string, source: string): Promise<readonly Linter.LintMessage[]> {
  const rule = await loadRule();
  const linter = new Linter({ configType: 'flat' });
  const effectiveFilename = filename.replace('/repo/', '');
  return linter.verify(source, [{
    files: ['**/*.ts'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { local: { rules: { 'test-architecture-boundaries': rule } } },
    rules: { 'local/test-architecture-boundaries': 'error' },
  }], { filename: effectiveFilename });
}

test('test boundary rule rejects focused-to-support dependency direction', async () => {
  const messages = await verify(
    '/repo/src/control-plane/example.test.ts',
    "import { fixture } from '../e2e/support/host-fixture.js';",
  );
  assert.deepEqual(messages.map((message) => message.messageId), ['direction']);
});

test('test boundary rule rejects lateral suite imports', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    "import '../integration/run-lifecycle.e2e.test.js';",
  );
  assert.deepEqual(messages.map((message) => message.messageId), ['lateral']);
});

test('test boundary rule rejects the broad E2E barrel', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    "import { anything } from '../support/index.js';",
  );
  assert.deepEqual(messages.map((message) => message.messageId), ['barrel']);
});

test('test boundary rule rejects raw service, privileged fixture, and handle access', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      "import { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';",
      "import { createHostFixture } from '../support/harness.js';",
      "import { createTargetRepo } from '../support/git-target-repo.js';",
      'void fixture.api;',
      'void fixture.dbos;',
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), [
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
  ]);
});

test('test boundary rule rejects raw runner, poller, worker, and process imports', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      "import { integrate } from '../../runners/integrator.js';",
      "import { pollPr } from '../../poller/pr-readiness.js';",
      "import { RunnerWorker } from '../../worker/runner.js';",
      "import { execFile } from 'node:child_process';",
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), [
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
  ]);
});

test('test boundary rule rejects child-process imports from public surface suites', async () => {
  const messages = await verify(
    '/repo/src/e2e/surfaces/mcp/example.e2e.test.ts',
    "import { spawn } from 'node:child_process';",
  );
  assert.deepEqual(messages.map((message) => message.messageId), ['rawAccess']);
});

test('test boundary rule rejects child-process subpaths and literal dynamic raw imports', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      "import { execFile } from 'node:child_process/promises';",
      "await import('../../runners/integrator.js');",
      "await import('../../poller/pr-readiness.js');",
      "await import('../../worker/runner.js');",
      "await import('../../providers/github.js');",
      "await import('node:child_process');",
      "await import('node:child_process/promises');",
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), [
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
  ]);
});

test('test boundary rule rejects static template-literal dynamic raw imports', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      'await import(`../../runners/integrator.js`);',
      'await import(`node:child_process/promises`);',
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), ['rawAccess', 'rawAccess']);
});

test('test boundary rule leaves interpolated dynamic imports non-static', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    'await import(`../../runners/${runnerName}.js`);',
  );
  assert.deepEqual(messages, []);
});

test('test boundary rule rejects computed and destructured aliases of privileged properties', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      "void fixture['api'];",
      'const { dbos } = fixture;',
      'const { lifecycle: hostLifecycle } = fixture;',
      "const { ['ghCalls']: providerCalls } = fixture;",
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), [
    'rawAccess',
    'rawAccess',
    'rawAccess',
    'rawAccess',
  ]);
});

test('test boundary rule rejects mutable run-routing maps', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      'const runCases = new Map();',
      'const routesByRunId = new Map();',
      'const providerResponsesByRun = new Map();',
      'const scenarioForRun = new Map();',
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), [
    'runRoutingMap',
    'runRoutingMap',
    'runRoutingMap',
    'runRoutingMap',
  ]);
});

test('test boundary rule rejects run-state routing maps through Map and globalThis.Map', async () => {
  const messages = await verify(
    '/repo/src/e2e/integration/example.e2e.test.ts',
    [
      'const runStateMap = new Map();',
      'const runStateById = new Map();',
      '{ const runStateMap = new globalThis.Map(); }',
      '{ const runStateById = new globalThis.Map(); }',
    ].join('\n'),
  );
  assert.deepEqual(messages.map((message) => message.messageId), [
    'runRoutingMap',
    'runRoutingMap',
    'runRoutingMap',
    'runRoutingMap',
  ]);
});

test('test boundary rule accepts unrelated maps and typed context dynamic imports', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    [
      'const runDurations = new Map();',
      'const stateByUserId = new globalThis.Map();',
      "await import('../support/pipeline-context.js');",
    ].join('\n'),
  );
  assert.deepEqual(messages, []);
});

test('test boundary rule accepts an explicit typed context import', async () => {
  const messages = await verify(
    '/repo/src/e2e/pipeline/example.e2e.test.ts',
    "import { createPipelineContext } from '../support/pipeline-context.js';",
  );
  assert.deepEqual(messages, []);
});
