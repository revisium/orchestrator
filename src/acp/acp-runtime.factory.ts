import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AcpJsonRpcConnection,
} from './jsonrpc/connection.js';
import type { JsonRpcConnectionDeps } from './jsonrpc/connection.types.js';
import {
  AcpJsonRpcFramer,
  type JsonRpcFramerOptions,
} from './jsonrpc/framer.js';
import {
  AcpOutcomeCollector,
  type AcpOutcomeCollectorDeps,
} from './outcome-collector.js';
import {
  AcpPermissionHandler,
  type AcpPermissionHandlerDeps,
} from './permission-handler.js';
import { AcpSession } from './session.js';
import type { CreateAcpSessionDependencies } from './session.types.js';

@Injectable()
export class AcpRuntimeFactory {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  async createFramer(options: JsonRpcFramerOptions = {}): Promise<AcpJsonRpcFramer> {
    const framer = await this.moduleRef.resolve(AcpJsonRpcFramer);
    framer.bindDependencies(options);
    return framer;
  }

  async createConnection(deps: JsonRpcConnectionDeps): Promise<AcpJsonRpcConnection> {
    const connection = await this.moduleRef.resolve(AcpJsonRpcConnection);
    connection.bindDependencies(deps);
    return connection;
  }

  async createSession(deps: CreateAcpSessionDependencies): Promise<AcpSession> {
    const session = await this.moduleRef.resolve(AcpSession);
    session.bindDependencies(deps);
    return session;
  }

  async createPermissionHandler(
    deps: AcpPermissionHandlerDeps,
  ): Promise<AcpPermissionHandler> {
    const handler = await this.moduleRef.resolve(AcpPermissionHandler);
    handler.bind(deps);
    return handler;
  }

  async createOutcomeCollector(
    deps: AcpOutcomeCollectorDeps,
  ): Promise<AcpOutcomeCollector> {
    const collector = await this.moduleRef.resolve(AcpOutcomeCollector);
    collector.bind(deps);
    return collector;
  }
}
