import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { AcpJsonRpcConnection } from '../../jsonrpc/connection.js';
import { AcpJsonRpcFramer } from '../../jsonrpc/framer.js';
import { AcpPermissionRequestHandler } from '../../prompt-execution/permission-request-handler.js';
import { AcpPromptOutcomeCollector } from '../../prompt-execution/prompt-outcome-collector.js';
import { AcpSession } from '../../session/session.js';
import { AcpModule, AcpRuntimeFactory, runAcpInvocation } from '../../index.js';
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

test('registers only the Nest ACP adapter and leaves core classes unmanaged', async (context) => {
  const application = await NestFactory.createApplicationContext(AcpModule, { logger: false });
  context.after(async () => { await application.close(); });

  const factory = application.get(AcpRuntimeFactory);
  assert.ok(factory instanceof AcpRuntimeFactory);
  assert.equal(typeof factory.runInvocation, 'function');
  for (const coreToken of [
    AcpJsonRpcFramer,
    AcpJsonRpcConnection,
    AcpSession,
    AcpPermissionRequestHandler,
    AcpPromptOutcomeCollector,
  ]) {
    assert.throws(() => application.get(coreToken));
  }
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
