import assert from 'node:assert/strict';
import test from 'node:test';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { coverageForScenario } from '../../testing/policy/pipeline-coverage.js';
import type { HostFixture } from './harness.js';
import { PipelineContext, type PipelineCase } from './pipeline-context.js';

test('pipeline context rejects added gate options before resolving the gate', async () => {
  let resolved = false;
  const resolvedInputs: unknown[] = [];
  const host = {
    api: {
      async createRun() {
        return { runId: 'run-1', taskId: 'task-1' };
      },
      async startRun() {
        return { alreadyStarted: false };
      },
      async waitForRun() {
        if (resolved) {
          return {
            state: 'completed',
            workflowStatus: 'SUCCESS',
            runStatus: 'completed',
            nextAction: '',
            runId: 'run-1',
          };
        }
        return {
          state: 'pending_gate',
          workflowStatus: 'PENDING',
          runStatus: 'running',
          nextAction: '',
          runId: 'run-1',
          inbox: {
            id: 'inbox-1',
            context: { topic: 'plan', summary: { outcomes: ['approved', 'surprise'] } },
            options: ['approved', 'surprise'],
          },
        };
      },
      async resolveGate(input: unknown) {
        resolvedInputs.push(input);
        resolved = true;
        return {};
      },
    },
    casePlans: { register() {} },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  const pipeline = new PipelineContext(host);

  await assert.rejects(
    () => pipeline.run({
      title: 'exact gate options',
      coverage: nonDslPipelineCaseAttachment('B3'),
      repo: 'workspace',
      developerWrite: false,
      gates: [{ topic: 'plan', options: ['approved'], outcome: 'approved' }],
      expect: { terminal: 'completed' },
    }),
    /unexpected plan gate options/,
  );
  assert.deepEqual(resolvedInputs, []);
});

test('pipeline context rejects a registered attachment bound to another profile before creating a run', async () => {
  let createCalls = 0;
  const host = {
    api: {
      async createRun() {
        createCalls += 1;
        throw new Error('run creation must not execute');
      },
    },
  } as unknown as HostFixture;
  const pipeline = new PipelineContext(host);

  await assert.rejects(
    () => pipeline.run({
      title: 'wrong registered profile',
      coverage: coverageForScenario('M1-profile-single'),
      repo: 'workspace',
      playbook: 'default',
      pipelineId: 'feature-development',
      profileId: 'claude-standard',
      developerWrite: false,
      expect: { terminal: 'completed' },
    }),
    /registered pipeline attachment does not match the selected materialized identity/,
  );
  assert.equal(createCalls, 0);
});

test('pipeline context executes the canonical coverage/given/when/then descriptor', async () => {
  let resolved = false;
  const host = {
    api: {
      async createRun(input: Record<string, unknown>) {
        assert.equal(input['title'], 'canonical descriptor');
        return { runId: 'run-1', taskId: 'task-1' };
      },
      async startRun() { return { alreadyStarted: false }; },
      async waitForRun() {
        return resolved
          ? { state: 'completed', workflowStatus: 'SUCCESS', runStatus: 'completed', nextAction: '', runId: 'run-1' }
          : {
              state: 'pending_gate', workflowStatus: 'PENDING', runStatus: 'running', nextAction: '', runId: 'run-1',
              inbox: { id: 'inbox-1', context: { topic: 'plan', summary: {} }, options: ['approved'] },
            };
      },
      async resolveGate() { resolved = true; return {}; },
    },
    casePlans: { register() {} },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  const pipeline = new PipelineContext(host);
  const descriptor: PipelineCase = {
    coverage: nonDslPipelineCaseAttachment('B3'),
    given: { title: 'canonical descriptor', repo: 'workspace', developerWrite: false },
    when: [{ do: 'resolveGate', topic: 'plan', options: ['approved'], outcome: 'approved' }],
    then: { terminal: 'completed' },
  };

  await pipeline.execute(descriptor);
  assert.equal(resolved, true);
});

test('pipeline context does not enumerate resolveGate actions into internal gate steps', async () => {
  let resolved = false;
  let actionEnumerations = 0;
  const host = {
    api: {
      async createRun() { return { runId: 'run-1', taskId: 'task-1' }; },
      async startRun() { return { alreadyStarted: false }; },
      async waitForRun() {
        return resolved
          ? { state: 'completed', workflowStatus: 'SUCCESS', runStatus: 'completed', nextAction: '', runId: 'run-1' }
          : {
              state: 'pending_gate', workflowStatus: 'PENDING', runStatus: 'running', nextAction: '', runId: 'run-1',
              inbox: { id: 'inbox-1', context: { topic: 'plan', summary: {} }, options: ['approved'] },
            };
      },
      async resolveGate() { resolved = true; return {}; },
    },
    casePlans: { register() {} },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  const action: PipelineCase['when'][number] = {
    do: 'resolveGate',
    topic: 'plan',
    options: ['approved'],
    outcome: 'approved',
  };
  const guardedAction = new Proxy(action, {
    ownKeys(target) {
      actionEnumerations += 1;
      return Reflect.ownKeys(target);
    },
  });

  await new PipelineContext(host).execute({
    coverage: nonDslPipelineCaseAttachment('B3'),
    given: { title: 'non-enumerated gate action', repo: 'workspace', developerWrite: false },
    when: [guardedAction],
    then: { terminal: 'completed' },
  });
  assert.equal(resolved, true);
  assert.equal(actionEnumerations, 0);
});
