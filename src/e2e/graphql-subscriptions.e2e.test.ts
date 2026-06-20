import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'graphql-ws';
import { findFreePort } from '../config.js';
import { startGraphqlHost, type StartedGraphqlHost } from '../http/graphql-host.js';
import { RUN_REAL_E2E, e2eSkip } from './kit/index.js';

let host: StartedGraphqlHost | null = null;

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  assert.ok(host, 'GraphQL host must be started');
  const response = await fetch(host.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join('; '));
  }
  assert.ok(json.data, 'GraphQL response must include data');
  return json.data;
}

function nextSubscription<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  assert.ok(host, 'GraphQL host must be started');
  const client = createClient({ url: host.url.replace('http://', 'ws://') });
  return new Promise<T>((resolve, reject) => {
    const dispose = client.subscribe(
      { query, variables },
      {
        next(value) {
          dispose();
          void client.dispose();
          resolve(value.data as T);
        },
        error(error) {
          void client.dispose();
          reject(error);
        },
        complete() {},
      },
    );
  });
}

before(async () => {
  if (!RUN_REAL_E2E) return;
  host = await startGraphqlHost({ port: await findFreePort(19600) });
});

after(async () => {
  await host?.app.close();
  host = null;
});

test('GraphQL subscriptions: subscribe → createRun mutation → runEventAppended payload', { skip: e2eSkip }, async () => {
  const event = nextSubscription<{ runEventAppended: { runId: string; type: string } }>(
    'subscription { runEventAppended { runId type } }',
  );
  const created = await graphql<{ createRun: { runId: string } }>(
    'mutation($data: CreateRunInput!) { createRun(data: $data) { runId } }',
    {
      data: {
        title: 'GraphQL subscription e2e',
        repo: '.',
        playbookId: 'revisium-agent-playbook',
        pipelineId: 'local-change',
        start: false,
      },
    },
  );
  const payload = await event;
  assert.equal(payload.runEventAppended.runId, created.createRun.runId);
  assert.equal(payload.runEventAppended.type, 'run_created');
});
