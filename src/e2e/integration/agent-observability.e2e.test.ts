import { after, before, test } from 'node:test';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createIntegrationContext,
  type IntegrationContext,
  type IntegrationTarget,
} from '../support/integration-context.js';

const MARKER = 'AGENT-LOG-MARKER-128';

let integration: IntegrationContext;
let target: IntegrationTarget;

before(async () => {
  if (!RUN_REAL_E2E) return;
  integration = await createIntegrationContext();
  target = integration.target();
});

after(async () => {
  if (integration) await integration.close();
});

test('agent-output stream persists reporter events for later reads', { skip: e2eSkip }, async () => {
  const run = await integration.prepare({
    title: 'agent observability stream',
    repo: target,
    pipelineId: 'local-change',
    profile: 'fixture-agent',
    developerWrite: false,
    agent: { default: { kind: 'reporter', marker: MARKER } },
  });
  await run.start();
  await run.settle('completed');
  await run.expectAgentOutput(MARKER);
});
