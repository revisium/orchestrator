import { Module } from '@nestjs/common';
import { AcpRuntimeFactory } from './acp-runtime.factory.js';
import { AcpJsonRpcConnection } from './jsonrpc/connection.js';
import { AcpJsonRpcFramer } from './jsonrpc/framer.js';
import { AcpPromptOutcomeCollector } from './interaction/prompt-outcome-collector.js';
import { AcpRequestPermissionHandler } from './interaction/request-permission-handler.js';
import { AcpSession } from './session.js';

@Module({
  providers: [
    AcpRuntimeFactory,
    AcpJsonRpcFramer,
    AcpJsonRpcConnection,
    AcpSession,
    AcpRequestPermissionHandler,
    AcpPromptOutcomeCollector,
  ],
  exports: [AcpRuntimeFactory],
})
export class AcpModule {}
