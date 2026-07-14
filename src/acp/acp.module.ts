import { Module } from '@nestjs/common';
import { AcpRuntimeFactory } from './acp-runtime.factory.js';
import { AcpJsonRpcConnection } from './jsonrpc/connection.js';
import { AcpJsonRpcFramer } from './jsonrpc/framer.js';
import { AcpOutcomeCollector } from './outcome-collector.js';
import { AcpPermissionHandler } from './permission-handler.js';
import { AcpSession } from './session.js';

@Module({
  providers: [
    AcpRuntimeFactory,
    AcpJsonRpcFramer,
    AcpJsonRpcConnection,
    AcpSession,
    AcpPermissionHandler,
    AcpOutcomeCollector,
  ],
  exports: [AcpRuntimeFactory],
})
export class AcpModule {}
