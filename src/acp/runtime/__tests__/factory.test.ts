import assert from 'node:assert/strict';
import test from 'node:test';
import { ModuleRef, NestFactory } from '@nestjs/core';
import { AcpJsonRpcConnection } from '../../jsonrpc/connection.js';
import { AcpJsonRpcFramer } from '../../jsonrpc/framer.js';
import { AcpPermissionRequestHandler } from '../../prompt-execution/permission-request-handler.js';
import { AcpPromptOutcomeCollector } from '../../prompt-execution/prompt-outcome-collector.js';
import { AcpSession } from '../../session/session.js';
import { AcpModule, AcpRuntimeFactory, runAcpInvocation } from '../../index.js';
import { AcpInvocation } from '../invocation.js';
import type {
  AcpAgentCapabilities,
  AcpBooleanConfigOptionCapabilities,
  AcpCanonicalObject,
  AcpConnector,
  AcpConnectorContext,
  AcpDiagnosticDetails,
  AcpDiagnosticScalar,
  AcpInboundHandlers,
  AcpInboundNotification,
  AcpImplementation,
  AcpInvocationDependencies,
  AcpInvocationDiagnostic,
  AcpInvocationProtocolDiagnosticCode,
  AcpInvocationRequest,
  AcpInvocationRuntimeDiagnosticCode,
  AcpInvocationSessionDiagnosticCode,
  AcpInitializeResponse,
  AcpNewSessionResponse,
  AcpOpenConnection,
  AcpOpenedConnection,
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionResolutionDecision,
  AcpPermissionResolutionRequest,
  AcpPermissionResolver,
  AcpPermissionToolCallSnapshot,
  AcpPromptExecutionDiagnostic,
  AcpPromptOutcome,
  AcpPromptProgress,
  AcpReportedCost,
  AcpReportedUsage,
  AcpSessionActivityDiscriminator,
  AcpSessionActivitySnapshot,
  AcpSessionCapabilities,
  AcpSessionCloseCapabilities,
  AcpSessionConfigBooleanOptionState,
  AcpSessionConfigOption,
  AcpSessionConfigOptionBase,
  AcpSessionConfigOptionCategory,
  AcpSessionConfigSelectGroup,
  AcpSessionConfigSelectOption,
  AcpSessionConfigSelectOptions,
  AcpSessionConfigSelectOptionState,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpSessionUpdateDiscriminator,
  AcpSetSessionConfigBooleanRequest,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
  AcpSetSessionConfigSelectRequest,
  AcpStopReason,
  JsonRpcConnection,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcParams,
  JsonRpcPrimitive,
  JsonRpcRequest,
  JsonRpcServerRequestOutcome,
  JsonRpcSuccessResponse,
  JsonRpcValue,
} from '../../index.js';

const publicConnector: AcpConnector = {
  async configure(context: AcpConnectorContext) {
    const { session, setConfigOption } = context;
    await setConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'provider/model',
    });
  },
};
const publicResolver: AcpPermissionResolver = async (
  _request: AcpPermissionResolutionRequest,
): Promise<AcpPermissionResolutionDecision> => ({ outcome: 'cancel' });
const publicScalar: AcpDiagnosticScalar = null;
const publicDetails: AcpDiagnosticDetails = { stable: publicScalar };

type PublicContractClosure = Readonly<{
  connector: AcpConnector;
  connectorContext: AcpConnectorContext;
  diagnostics: readonly [
    AcpDiagnosticDetails,
    AcpDiagnosticScalar,
    AcpInvocationDiagnostic,
    AcpInvocationProtocolDiagnosticCode,
    AcpInvocationRuntimeDiagnosticCode,
    AcpInvocationSessionDiagnosticCode,
    AcpPromptExecutionDiagnostic,
  ];
  invocation: readonly [
    AcpInboundHandlers,
    AcpInboundNotification,
    AcpInvocationDependencies,
    AcpInvocationRequest,
    AcpOpenConnection,
    AcpOpenedConnection,
    AcpPromptOutcome,
    AcpPromptProgress,
  ];
  permission: readonly [
    AcpPermissionOption,
    AcpPermissionOptionKind,
    AcpPermissionResolutionDecision,
    AcpPermissionResolutionRequest,
    AcpPermissionResolver,
    AcpPermissionToolCallSnapshot,
  ];
  protocol: readonly [
    AcpAgentCapabilities,
    AcpBooleanConfigOptionCapabilities,
    AcpCanonicalObject,
    AcpImplementation,
    AcpInitializeResponse,
    AcpNewSessionResponse,
    AcpReportedCost,
    AcpReportedUsage,
    AcpSessionActivityDiscriminator,
    AcpSessionActivitySnapshot,
    AcpSessionCapabilities,
    AcpSessionCloseCapabilities,
    AcpSessionConfigBooleanOptionState,
    AcpSessionConfigOption,
    AcpSessionConfigOptionBase,
    AcpSessionConfigOptionCategory,
    AcpSessionConfigSelectGroup,
    AcpSessionConfigSelectOption,
    AcpSessionConfigSelectOptions,
    AcpSessionConfigSelectOptionState,
    AcpSessionNotification,
    AcpSessionUpdate,
    AcpSessionUpdateDiscriminator,
    AcpSetSessionConfigBooleanRequest,
    AcpSetSessionConfigOptionRequest,
    AcpSetSessionConfigOptionResponse,
    AcpSetSessionConfigSelectRequest,
    AcpStopReason,
  ];
  jsonRpc: readonly [
    JsonRpcConnection,
    JsonRpcErrorObject,
    JsonRpcErrorResponse,
    JsonRpcId,
    JsonRpcMessage,
    JsonRpcNotification,
    JsonRpcParams,
    JsonRpcPrimitive,
    JsonRpcRequest,
    JsonRpcServerRequestOutcome,
    JsonRpcSuccessResponse,
    JsonRpcValue,
  ];
}>;

const publicContractKey: keyof PublicContractClosure = 'connector';

test('resolves isolated invocation graphs for sequential and overlapping factory calls', async (context) => {
  const module = await NestFactory.createApplicationContext(AcpModule, { logger: false });
  context.after(async () => { await module.close(); });

  const factory = module.get(AcpRuntimeFactory);
  const moduleRef = module.get(ModuleRef);
  const resolved: AcpInvocation[] = [];
  const originalResolve = moduleRef.resolve.bind(moduleRef);
  moduleRef.resolve = (async (...args: Parameters<ModuleRef['resolve']>) => {
    const invocation = await originalResolve<AcpInvocation>(...args) as AcpInvocation;
    resolved.push(invocation);
    return invocation;
  }) as ModuleRef['resolve'];

  const request = { cwd: '/tmp', prompt: 'prompt', clientInfo: { name: 'test', version: '1' } };
  const failure = new Error('boundary probe');
  const deps = {
    openConnection: async () => { throw failure; },
    connector: publicConnector,
    resolvePermission: publicResolver,
    onDiagnostic() {},
  };

  await Promise.all([
    assert.rejects(factory.runInvocation(request, deps), failure),
    assert.rejects(factory.runInvocation(request, deps), failure),
  ]);
  await assert.rejects(factory.runInvocation(request, deps), failure);

  assert.equal(resolved.length, 3);
  const graphs = resolved.map((invocation) => ({
    invocation,
    session: Reflect.get(invocation, 'session'),
    permissionHandler: Reflect.get(invocation, 'permissionHandler'),
    outcomeCollector: Reflect.get(invocation, 'outcomeCollector'),
  }));
  for (const graph of graphs) {
    assert.ok(graph.session instanceof AcpSession);
    assert.ok(graph.permissionHandler instanceof AcpPermissionRequestHandler);
    assert.ok(graph.outcomeCollector instanceof AcpPromptOutcomeCollector);
  }
  for (const [left, right] of [[0, 1], [0, 2], [1, 2]] as const) {
    assert.notEqual(graphs[left]!.invocation, graphs[right]!.invocation);
    assert.notEqual(graphs[left]!.session, graphs[right]!.session);
    assert.notEqual(graphs[left]!.permissionHandler, graphs[right]!.permissionHandler);
    assert.notEqual(graphs[left]!.outcomeCollector, graphs[right]!.outcomeCollector);
  }
  assert.throws(() => module.get(AcpJsonRpcFramer));
  assert.throws(() => module.get(AcpJsonRpcConnection));
});

test('exposes a transitively closed root-only public API', () => {
  assert.equal(typeof AcpModule, 'function');
  assert.equal(typeof AcpRuntimeFactory, 'function');
  assert.equal(typeof runAcpInvocation, 'function');
  assert.equal(publicConnector.configure instanceof Function, true);
  assert.equal(publicResolver instanceof Function, true);
  assert.deepEqual(publicDetails, { stable: null });
  assert.equal(publicContractKey, 'connector');
});
