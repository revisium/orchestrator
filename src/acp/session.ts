import { Injectable, Scope } from '@nestjs/common';
import type { JsonRpcValue } from './jsonrpc/types.js';
import { AcpSessionError } from './session.errors.js';
import { createDeferredPromise, isJsonRpcValue, isPlainRecord } from './session.helpers.js';
import type {
  AcpSessionController,
  AcpSessionDiagnosticCode,
  CreateAcpSessionDependencies,
} from './session.types.js';

type State =
  | 'new'
  | 'initializing'
  | 'initialized'
  | 'creating'
  | 'session-created'
  | 'configured'
  | 'prompted'
  | 'failed'
  | 'closing'
  | 'closed';

@Injectable({ scope: Scope.TRANSIENT })
export class AcpSession implements AcpSessionController {
  private deps: CreateAcpSessionDependencies | undefined;
  private state: State = 'new';
  private createdSessionId: string | null = null;
  private updateFailure: AcpSessionError | null = null;
  private createOperationSettled: ReturnType<typeof createDeferredPromise> | null = null;
  private configuring = false;
  private closeOperation: Promise<void> | null = null;
  private closeWireOperation: Promise<void> | null = null;

  bindDependencies(deps: CreateAcpSessionDependencies): void {
    if (this.deps) throw new Error('ACP session is already bound');
    this.deps = deps;
  }

  private getDependencies(): CreateAcpSessionDependencies {
    if (!this.deps) throw new Error('ACP session is not bound');
    return this.deps;
  }

  private reportDiagnostic(code: AcpSessionDiagnosticCode, message: string, details?: unknown): void {
    try {
      this.getDependencies().onDiagnostic({ code, message, details });
    } catch {}
  }

  private throwSessionUnavailable(): never {
    if (this.state === 'closed' || this.state === 'closing') throw new AcpSessionError('closed');
    if (this.updateFailure) throw this.updateFailure;
    if (this.state === 'failed') throw new AcpSessionError('failed');
    throw new Error('ACP session is available');
  }

  private assertNotTerminalState(): void {
    if (this.state === 'closed' || this.state === 'closing' || this.state === 'failed') this.throwSessionUnavailable();
  }

  private markFailed(_error: unknown): void {
    if (this.state !== 'closing' && this.state !== 'closed') this.state = 'failed';
  }

  private isClosingOrClosed(): boolean {
    return this.state === 'closing' || this.state === 'closed';
  }

  private async sendSessionCloseRequest(): Promise<void> {
    if (!this.createdSessionId) return;
    if (this.closeWireOperation) return this.closeWireOperation;
    const sessionId = this.createdSessionId;
    this.closeWireOperation = this.getDependencies().connection.request('session/close', { sessionId })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.reportDiagnostic('close_failed', 'ACP session close failed', error);
      });
    return this.closeWireOperation;
  }

  async initialize(): Promise<void> {
    this.assertNotTerminalState();
    if (this.state !== 'new') throw new AcpSessionError('initialize_already_started');
    this.state = 'initializing';
    try {
      const response = await this.getDependencies().connection.request('initialize', { protocolVersion: 1 });
      if (!isPlainRecord(response) || response.protocolVersion !== 1) {
        const error = new AcpSessionError('invalid_protocol_version');
        this.markFailed(error);
        throw error;
      }
      if (!this.isClosingOrClosed()) this.state = 'initialized';
    } catch (error) {
      if (error instanceof AcpSessionError) throw error;
      this.markFailed(error);
      throw error;
    }
  }

  async create(): Promise<string> {
    this.assertNotTerminalState();
    if (this.state !== 'initialized') throw new AcpSessionError('session_new_already_started');
    this.state = 'creating';
    this.createOperationSettled = createDeferredPromise();
    try {
      const response = await this.getDependencies().connection.request('session/new');
      if (!isPlainRecord(response) || !Object.hasOwn(response, 'sessionId') ||
        typeof response.sessionId !== 'string' || response.sessionId.length === 0) {
        const error = new AcpSessionError('invalid_session_id');
        this.markFailed(error);
        throw error;
      }
      this.createdSessionId = response.sessionId;
      if (this.isClosingOrClosed()) {
        await this.sendSessionCloseRequest();
      } else {
        this.state = 'session-created';
      }
      return this.createdSessionId;
    } catch (error) {
      if (error instanceof AcpSessionError) throw error;
      this.markFailed(error);
      throw error;
    } finally {
      this.createOperationSettled.resolve();
    }
  }

  async configure(): Promise<void> {
    this.assertNotTerminalState();
    if (this.state === 'new' || this.state === 'initializing' || this.state === 'initialized' || this.state === 'creating') {
      throw new AcpSessionError('configuration_before_session');
    }
    if (this.state !== 'session-created') throw new AcpSessionError('configuration_already_started');
    const sessionId = this.createdSessionId;
    if (!sessionId) throw new AcpSessionError('configuration_before_session');
    this.state = 'configured';
    this.configuring = true;
    try {
      await this.getDependencies().configure(sessionId);
    } catch (error) {
      this.markFailed(error);
      throw error;
    } finally {
      this.configuring = false;
    }
  }

  async prompt(promptValue: JsonRpcValue): Promise<JsonRpcValue> {
    this.assertNotTerminalState();
    if (this.configuring || this.state === 'new' || this.state === 'initializing' || this.state === 'initialized' || this.state === 'creating' || this.state === 'session-created') {
      throw new AcpSessionError('prompt_before_session');
    }
    if (this.state !== 'configured') throw new AcpSessionError('prompt_already_started');
    const sessionId = this.createdSessionId;
    if (!sessionId) throw new AcpSessionError('prompt_before_session');
    this.state = 'prompted';
    try {
      return await this.getDependencies().connection.request('session/prompt', { sessionId, prompt: promptValue });
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async receiveUpdate(params: unknown): Promise<void> {
    this.assertNotTerminalState();
    if (this.state !== 'session-created' && this.state !== 'configured' && this.state !== 'prompted') {
      const error = new AcpSessionError('unexpected_update');
      this.updateFailure = error;
      this.state = 'failed';
      this.reportDiagnostic('unexpected_update', 'Unexpected ACP session update', params);
      throw error;
    }
    if (!isPlainRecord(params) || !Object.hasOwn(params, 'sessionId') || !Object.hasOwn(params, 'update') ||
      typeof params.sessionId !== 'string' || params.sessionId.length === 0 || !isJsonRpcValue(params.update)) {
      const error = new AcpSessionError('malformed_session_update');
      this.updateFailure = error;
      this.state = 'failed';
      this.reportDiagnostic('malformed_session_update', 'Malformed ACP session update', params);
      throw error;
    }
    if (params.sessionId !== this.createdSessionId) {
      const error = new AcpSessionError('foreign_session_update');
      this.updateFailure = error;
      this.state = 'failed';
      this.reportDiagnostic('foreign_session_update', 'Foreign ACP session update', params);
      throw error;
    }
    try {
      await this.getDependencies().onUpdate({ sessionId: params.sessionId, update: params.update });
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.state = 'closing';
    this.closeOperation = (async () => {
      if (!this.createdSessionId && this.createOperationSettled) await this.createOperationSettled.promise;
      await this.sendSessionCloseRequest();
      this.state = 'closed';
    })();
    return this.closeOperation;
  }

  getSessionId(): string | null {
    return this.createdSessionId;
  }
}

export function createAcpSession(deps: CreateAcpSessionDependencies): AcpSessionController {
  const session = new AcpSession();
  session.bindDependencies(deps);
  return session;
}
