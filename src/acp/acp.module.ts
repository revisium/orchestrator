import { Module } from '@nestjs/common';
import { AcpRuntimeFactory } from './acp-runtime.factory.js';
import { AcpJsonRpcConnection } from './jsonrpc/connection.js';
import { AcpJsonRpcFramer } from './jsonrpc/framer.js';
import { AcpSession } from './session.js';

@Module({
  providers: [AcpRuntimeFactory, AcpJsonRpcFramer, AcpJsonRpcConnection, AcpSession],
  exports: [AcpRuntimeFactory],
})
export class AcpModule {}
