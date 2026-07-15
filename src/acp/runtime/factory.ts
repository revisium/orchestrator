import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AcpJsonRpcConnection,
} from '../jsonrpc/connection.js';
import type { JsonRpcConnectionDeps } from '../jsonrpc/connection.types.js';
import {
  AcpJsonRpcFramer,
  type JsonRpcFramerOptions,
} from '../jsonrpc/framer.js';
import {
  AcpPromptOutcomeCollector,
  type AcpPromptOutcomeCollectorDeps,
} from '../prompt-execution/prompt-outcome-collector.js';
import {
  AcpPermissionRequestHandler,
  type AcpPermissionRequestHandlerDeps,
} from '../prompt-execution/permission-request-handler.js';
import { AcpSession } from '../session/session.js';
import type { AcpSessionDependencies } from '../session/types.js';

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

  async createSession(deps: AcpSessionDependencies): Promise<AcpSession> {
    const session = await this.moduleRef.resolve(AcpSession);
    session.bind(deps);
    return session;
  }

  async createRequestPermissionHandler(
    deps: AcpPermissionRequestHandlerDeps,
  ): Promise<AcpPermissionRequestHandler> {
    const handler = await this.moduleRef.resolve(AcpPermissionRequestHandler);
    handler.bind(deps);
    return handler;
  }

  async createPromptOutcomeCollector(
    deps: AcpPromptOutcomeCollectorDeps,
  ): Promise<AcpPromptOutcomeCollector> {
    const collector = await this.moduleRef.resolve(AcpPromptOutcomeCollector);
    collector.bind(deps);
    return collector;
  }
}
