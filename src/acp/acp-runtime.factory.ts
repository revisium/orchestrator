import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AcpJsonRpcConnection,
  type JsonRpcConnectionDeps,
} from './jsonrpc/connection.js';
import {
  AcpJsonRpcFramer,
  type JsonRpcFramerOptions,
} from './jsonrpc/framer.js';
import { AcpSession, type CreateAcpSessionDeps } from './session.js';

@Injectable()
export class AcpRuntimeFactory {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  async createFramer(options: JsonRpcFramerOptions = {}): Promise<AcpJsonRpcFramer> {
    const framer = await this.moduleRef.resolve(AcpJsonRpcFramer);
    framer.bind(options);
    return framer;
  }

  async createConnection(deps: JsonRpcConnectionDeps): Promise<AcpJsonRpcConnection> {
    const connection = await this.moduleRef.resolve(AcpJsonRpcConnection);
    connection.bind(deps);
    return connection;
  }

  async createSession(deps: CreateAcpSessionDeps): Promise<AcpSession> {
    const session = await this.moduleRef.resolve(AcpSession);
    session.bind(deps);
    return session;
  }
}
