import { Module, Scope } from '@nestjs/common';
import { AcpRuntimeFactory } from './runtime/factory.js';
import { AcpJsonRpcConnection } from './jsonrpc/connection.js';
import { AcpJsonRpcFramer } from './jsonrpc/framer.js';
import { AcpPromptOutcomeCollector } from './prompt-execution/prompt-outcome-collector.js';
import { AcpPermissionRequestHandler } from './prompt-execution/permission-request-handler.js';
import { AcpSession } from './session/session.js';

@Module({
  providers: [
    AcpRuntimeFactory,
    { provide: AcpJsonRpcFramer, useClass: AcpJsonRpcFramer, scope: Scope.TRANSIENT },
    { provide: AcpJsonRpcConnection, useClass: AcpJsonRpcConnection, scope: Scope.TRANSIENT },
    { provide: AcpSession, useClass: AcpSession, scope: Scope.TRANSIENT },
    { provide: AcpPermissionRequestHandler, useClass: AcpPermissionRequestHandler, scope: Scope.TRANSIENT },
    { provide: AcpPromptOutcomeCollector, useClass: AcpPromptOutcomeCollector, scope: Scope.TRANSIENT },
  ],
  exports: [AcpRuntimeFactory],
})
export class AcpModule {}
