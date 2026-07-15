import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcpPermissionRequest } from '../../protocol/values.js';
import {
  AcpPermissionRequestHandler,
  type AcpPermissionResolver,
  type AcpPermissionResolutionRequest,
} from '../permission-request-handler.js';

const REQUEST: AcpPermissionRequest = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'tool-1', title: 'Read' },
  options: [
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  ],
};

test('resolves a typed permission and serializes the exact offered option id', async () => {
  const seen: unknown[] = [];
  const resolvePermission: AcpPermissionResolver = async (request) => {
    seen.push(request);
    return { outcome: 'select', optionKind: 'allow_once' };
  };
  const handler = new AcpPermissionRequestHandler();
  handler.bind({ resolvePermission });

  const result = await handler.handle(REQUEST);

  assert.deepEqual(result, {
    outcome: 'selected',
    response: { outcome: { outcome: 'selected', optionId: 'allow' } },
  });
  assert.deepEqual(seen, [{
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    toolCallSnapshot: { toolCallId: 'tool-1', title: 'Read' },
    options: [
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    ],
  }]);
});

test('rejects handle before dependencies are bound', async () => {
  const handler = new AcpPermissionRequestHandler();

  await assert.rejects(handler.handle(REQUEST), new Error('ACP permission handler is not bound'));
});

test('rejects binding dependencies more than once', () => {
  const handler = new AcpPermissionRequestHandler();
  const resolvePermission: AcpPermissionResolver = async () => ({ outcome: 'cancel' });
  handler.bind({ resolvePermission });

  assert.throws(
    () => handler.bind({ resolvePermission }),
    new Error('ACP permission handler is already bound'),
  );
});

test('returns resolver-cancelled when the resolver cancels', async () => {
  const handler = new AcpPermissionRequestHandler();
  handler.bind({ resolvePermission: async () => ({ outcome: 'cancel' }) });

  assert.deepEqual(await handler.handle(REQUEST), {
    outcome: 'cancelled',
    reason: 'resolver-cancelled',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{
      severity: 'error',
      reason: 'resolver-cancelled',
      message: 'Permission resolver cancelled the request',
    }],
  });
});

test('cancels without fallback when the required option kind was not offered', async () => {
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    resolvePermission: async () => ({ outcome: 'select', optionKind: 'reject_always' }),
  });

  assert.deepEqual(await handler.handle(REQUEST), {
    outcome: 'cancelled',
    reason: 'required-option-unavailable',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{
      severity: 'error',
      reason: 'required-option-unavailable',
      message: 'Required permission option was not offered',
    }],
  });
});

test('contains invalid hostile resolver decisions', async () => {
  const accessorDecision = {
    get outcome(): string { throw new Error('hostile decision accessor'); },
  };
  const trappedDecision = new Proxy({ outcome: 'cancel' }, {
    ownKeys() { throw new Error('hostile decision proxy'); },
  });
  const pollutedDecision = Object.assign(Object.create({ polluted: true }), { outcome: 'cancel' });

  for (const decision of [accessorDecision, trappedDecision, pollutedDecision]) {
    const handler = new AcpPermissionRequestHandler();
    handler.bind({ resolvePermission: (async () => decision) as AcpPermissionResolver });

    assert.deepEqual(await handler.handle(REQUEST), {
      outcome: 'cancelled',
      reason: 'invalid-decision',
      response: { outcome: { outcome: 'cancelled' } },
      diagnostics: [{
        severity: 'error',
        reason: 'invalid-decision',
        message: 'Permission resolver returned an invalid decision',
      }],
    });
  }
});

test('contains resolver failure without exposing the thrown message', async () => {
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    async resolvePermission() {
      throw new Error('sensitive resolver failure');
    },
  });

  const result = await handler.handle(REQUEST);

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'resolver-failed',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'resolver-failed', message: 'Permission resolver failed' }],
  });
  assert.doesNotMatch(JSON.stringify(result), /sensitive resolver failure/);
});

test('isolates the resolver request from parsed input and later handles', async () => {
  const seen: AcpPermissionResolutionRequest[] = [];
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    resolvePermission: async (request) => {
      seen.push(structuredClone(request));
      const mutableRequest = request as unknown as {
        toolCallSnapshot: { title: string; rawInput: { path: string } };
        options: Array<{ optionId: string; name: string }>;
      };
      mutableRequest.toolCallSnapshot.title = 'Mutated';
      mutableRequest.toolCallSnapshot.rawInput.path = '/mutated';
      mutableRequest.options[0]!.optionId = 'mutated';
      mutableRequest.options[0]!.name = 'Mutated';
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const request: AcpPermissionRequest = {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1', title: 'Read', rawInput: { path: '/before' } },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };

  const first = await handler.handle(request);
  const second = await handler.handle(request);

  assert.deepEqual(first, {
    outcome: 'selected',
    response: { outcome: { outcome: 'selected', optionId: 'allow' } },
  });
  assert.deepEqual(second, first);
  assert.deepEqual(request, {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1', title: 'Read', rawInput: { path: '/before' } },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });
  assert.deepEqual(seen, [seen[0], seen[0]]);
});

test('creates isolated cancellation responses and diagnostics', async () => {
  const handler = new AcpPermissionRequestHandler();
  handler.bind({ resolvePermission: async () => ({ outcome: 'cancel' }) });
  const first = await handler.handle(REQUEST);
  const mutableFirst = first as unknown as {
    response: { outcome: { outcome: string } };
    diagnostics: Array<{ severity: string; reason: string; message: string }>;
  };
  mutableFirst.response.outcome.outcome = 'mutated';
  mutableFirst.diagnostics[0]!.severity = 'mutated';

  assert.deepEqual(await handler.handle(REQUEST), {
    outcome: 'cancelled',
    reason: 'resolver-cancelled',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{
      severity: 'error',
      reason: 'resolver-cancelled',
      message: 'Permission resolver cancelled the request',
    }],
  });
});
