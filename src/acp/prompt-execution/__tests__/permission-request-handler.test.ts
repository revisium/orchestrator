import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AcpPermissionRequestHandler,
  type AcpPermissionHandlingResult,
  type AcpPermissionResolver,
  type AcpPermissionResolutionRequest,
  type AcpPermissionResponse,
} from '../permission-request-handler.js';

function requestPermissionResponse(
  outcome: AcpPermissionResponse['outcome'],
): AcpPermissionResponse {
  return { outcome };
}

function assertPermissionResultNarrowing(result: AcpPermissionHandlingResult): void {
  if (result.outcome === 'selected') {
    const optionId: string = result.response.outcome.optionId;
    assert.equal(typeof optionId, 'string');
    return;
  }
  const cancelledOutcome: 'cancelled' = result.response.outcome.outcome;
  assert.equal(cancelledOutcome, 'cancelled');
}

test('selects the first offered option of the resolver-required kind', async () => {
  const requests: AcpPermissionResolutionRequest[] = [];
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission(request) {
      requests.push(request);
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const params = {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow-first', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-second', name: 'Allow once again', kind: 'allow_once' },
    ],
  };

  const result = await handler.handle(params);

  assertPermissionResultNarrowing(result);
  assert.deepEqual(requestPermissionResponse(result.response.outcome), result.response);
  assert.deepEqual(result, {
    outcome: 'selected',
    response: { outcome: { outcome: 'selected', optionId: 'allow-first' } },
  });
  assert.deepEqual(requests, [{
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    toolCallSnapshot: { toolCallId: 'tool-1' },
    options: [
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow-first', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-second', name: 'Allow once again', kind: 'allow_once' },
    ],
  }]);
});

test('rejects handle before dependencies are bound', async () => {
  const handler = new AcpPermissionRequestHandler();

  await assert.rejects(
    handler.handle({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }),
    new Error('ACP permission handler is not bound'),
  );
});

test('rejects binding dependencies more than once', () => {
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() { return { outcome: 'cancel' }; },
  });

  assert.throws(
    () => handler.bind({
      expectedSessionId: 'session-2',
      async resolvePermission() { return { outcome: 'cancel' }; },
    }),
    new Error('ACP permission handler is already bound'),
  );
});

test('cancels a permission request whose params are not a record', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });

  const result = await handler.handle(null);

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'malformed-request',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{
      severity: 'error',
      reason: 'malformed-request',
      message: 'Permission request is malformed',
    }],
  });
  assert.equal(resolverCalls, 0);
});

test('contains hostile permission request shapes as malformed requests', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const validParams = {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };
  const accessorParams = {
    get sessionId(): string { throw new Error('hostile session accessor'); },
    toolCall: validParams.toolCall,
    options: validParams.options,
  };
  const trappedParams = new Proxy(validParams, {
    ownKeys() { throw new Error('hostile request proxy'); },
  });
  const revokedParams = Proxy.revocable(validParams, {});
  revokedParams.revoke();
  const pollutedParams = Object.assign(Object.create({ polluted: true }), validParams);
  const accessorOption = {
    get optionId(): string { throw new Error('hostile option accessor'); },
    name: 'Allow',
    kind: 'allow_once',
  };
  const trappedOptions = new Proxy(validParams.options, {
    ownKeys() { throw new Error('hostile options proxy'); },
  });
  const cases: unknown[] = [
    accessorParams,
    trappedParams,
    revokedParams.proxy,
    pollutedParams,
    { ...validParams, options: [accessorOption] },
    { ...validParams, options: trappedOptions },
  ];

  for (const params of cases) {
    assert.deepEqual(await handler.handle(params), {
      outcome: 'cancelled',
      reason: 'malformed-request',
      response: { outcome: { outcome: 'cancelled' } },
      diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
    });
  }
  assert.equal(resolverCalls, 0);
});

test('cancels permission requests without an own string sessionId', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const cases: unknown[] = [
    {
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
    {
      sessionId: 1,
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
  ];

  for (const params of cases) {
    assert.deepEqual(await handler.handle(params), {
      outcome: 'cancelled',
      reason: 'malformed-request',
      response: { outcome: { outcome: 'cancelled' } },
      diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
    });
  }
  assert.equal(resolverCalls, 0);
});

test('cancels permission requests without an own object toolCall', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
  const cases: unknown[] = [
    { sessionId: 'session-1', options },
    { sessionId: 'session-1', toolCall: null, options },
    { sessionId: 'session-1', toolCall: 'tool-1', options },
    { sessionId: 'session-1', toolCall: [{ toolCallId: 'tool-1' }], options },
  ];

  for (const params of cases) {
    assert.deepEqual(await handler.handle(params), {
      outcome: 'cancelled',
      reason: 'malformed-request',
      response: { outcome: { outcome: 'cancelled' } },
      diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
    });
  }
  assert.equal(resolverCalls, 0);
});

test('cancels permission requests without an own non-empty string toolCallId', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
  const cases: unknown[] = [
    { sessionId: 'session-1', toolCall: {}, options },
    { sessionId: 'session-1', toolCall: { toolCallId: 1 }, options },
    { sessionId: 'session-1', toolCall: { toolCallId: '' }, options },
  ];

  for (const params of cases) {
    assert.deepEqual(await handler.handle(params), {
      outcome: 'cancelled',
      reason: 'malformed-request',
      response: { outcome: { outcome: 'cancelled' } },
      diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
    });
  }
  assert.equal(resolverCalls, 0);
});

test('isolates nested tool-call values before resolving permission', async () => {
  let capturedRequest: AcpPermissionResolutionRequest | undefined;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission(request) {
      capturedRequest = request;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const params = {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'tool-1',
      rawInput: { command: { path: '/before' } },
    },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };

  const handling = handler.handle(params);
  params.toolCall.rawInput.command.path = '/after';
  await handling;

  assert.ok(capturedRequest);
  const toolCallSnapshot = capturedRequest.toolCallSnapshot as {
    rawInput: { command: { path: string } };
  };
  assert.equal(toolCallSnapshot.rawInput.command.path, '/before');
});

test('cancels a non-JSON nested tool-call value', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'tool-1',
      rawInput: { transform: () => 'invalid' },
    },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'malformed-request',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
  });
  assert.equal(resolverCalls, 0);
});

test('cancels a permission request whose options are not an array', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: {},
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'malformed-request',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
  });
  assert.equal(resolverCalls, 0);
});

test('cancels permission requests containing malformed options', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission(request) {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: request.options[0]?.kind };
    },
  });
  const invalidOptions: unknown[] = [
    { name: 'Allow', kind: 'allow_once' },
    { optionId: 1, name: 'Allow', kind: 'allow_once' },
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'allow', name: 1, kind: 'allow_once' },
    { optionId: 'allow', name: 'Allow' },
    { optionId: 'allow', name: 'Allow', kind: 'unknown' },
    { optionId: 'allow', name: 'Allow', kind: 1 },
  ];

  const results = await Promise.all(invalidOptions.map((option) => handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [option],
  })));

  assert.deepEqual(results, invalidOptions.map(() => ({
    outcome: 'cancelled',
    reason: 'malformed-request',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'malformed-request', message: 'Permission request is malformed' }],
  })));
  assert.equal(resolverCalls, 0);
});

test('cancels a case-sensitive foreign session before resolving permission', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'Session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'foreign-session',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'foreign-session', message: 'Permission request belongs to another session' }],
  });
  assert.equal(resolverCalls, 0);
});

test('returns resolver-cancelled when the resolver cancels', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'cancel' };
    },
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'resolver-cancelled',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'resolver-cancelled', message: 'Permission resolver cancelled the request' }],
  });
  assert.equal(resolverCalls, 1);
});

test('cancels without fallback when the required option kind was not offered', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'select', optionKind: 'reject_always' };
    },
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'required-option-unavailable',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{
      severity: 'error',
      reason: 'required-option-unavailable',
      message: 'Required permission option was not offered',
    }],
  });
  assert.equal(resolverCalls, 1);
});

test('cancels an invalid resolver decision', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  const resolvePermission = (async () => {
    resolverCalls += 1;
    return { outcome: 'select', optionKind: 'unknown' };
  }) as unknown as AcpPermissionResolver;
  handler.bind({
    expectedSessionId: 'session-1',
    resolvePermission,
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'invalid-decision',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'invalid-decision', message: 'Permission resolver returned an invalid decision' }],
  });
  assert.equal(resolverCalls, 1);
});

test('contains hostile resolver decisions as invalid decisions', async () => {
  const validParams = {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };
  const accessorDecision = {
    get outcome(): string { throw new Error('hostile decision accessor'); },
  };
  const trappedDecision = new Proxy({ outcome: 'cancel' }, {
    ownKeys() { throw new Error('hostile decision proxy'); },
  });
  const pollutedDecision = Object.assign(Object.create({ polluted: true }), { outcome: 'cancel' });
  const decisions: unknown[] = [
    accessorDecision,
    trappedDecision,
    pollutedDecision,
  ];

  for (const rawDecision of decisions) {
    const handler = new AcpPermissionRequestHandler();
    handler.bind({
      expectedSessionId: 'session-1',
      resolvePermission: (async () => rawDecision) as AcpPermissionResolver,
    });

    assert.deepEqual(await handler.handle(validParams), {
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

test('contains a revoked resolver result as a resolver failure', async () => {
  const revokedDecision = Proxy.revocable({ outcome: 'cancel' }, {});
  revokedDecision.revoke();
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    resolvePermission: (async () => revokedDecision.proxy) as AcpPermissionResolver,
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'resolver-failed',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'resolver-failed', message: 'Permission resolver failed' }],
  });
});

test('contains resolver failure without exposing the thrown message', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      throw new Error('sensitive resolver failure');
    },
  });

  const result = await handler.handle({
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

  assert.deepEqual(result, {
    outcome: 'cancelled',
    reason: 'resolver-failed',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'resolver-failed', message: 'Permission resolver failed' }],
  });
  assert.doesNotMatch(JSON.stringify(result), /sensitive resolver failure/);
  assert.equal(resolverCalls, 1);
});

test('creates isolated cancellation responses and diagnostics', async () => {
  let resolverCalls = 0;
  const handler = new AcpPermissionRequestHandler();
  handler.bind({
    expectedSessionId: 'session-1',
    async resolvePermission() {
      resolverCalls += 1;
      return { outcome: 'cancel' };
    },
  });
  const request = {
    sessionId: 'foreign-session',
    toolCall: { toolCallId: 'tool-1' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  };

  const first = await handler.handle(request);
  const mutableFirst = first as unknown as {
    response: { outcome: { outcome: string } };
    diagnostics: Array<{ severity: string; reason: string; message: string }>;
  };
  mutableFirst.response.outcome.outcome = 'mutated';
  mutableFirst.diagnostics[0]!.severity = 'mutated';
  mutableFirst.diagnostics[0]!.reason = 'mutated';
  mutableFirst.diagnostics[0]!.message = 'mutated';
  const second = await handler.handle(request);

  assert.deepEqual(second, {
    outcome: 'cancelled',
    reason: 'foreign-session',
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason: 'foreign-session', message: 'Permission request belongs to another session' }],
  });
  assert.equal(resolverCalls, 0);
});
