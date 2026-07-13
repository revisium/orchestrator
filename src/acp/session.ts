import { Injectable, Scope } from '@nestjs/common';
import type { JsonRpcConnection } from './jsonrpc/connection.js';
import type { JsonRpcValue } from './jsonrpc/types.js';

export type AcpSessionFailureCode =
  | 'invalid_protocol_version'
  | 'invalid_session_id'
  | 'initialize_already_started'
  | 'session_new_already_started'
  | 'configuration_before_session'
  | 'configuration_already_started'
  | 'prompt_before_session'
  | 'prompt_already_started'
  | 'unexpected_update'
  | 'foreign_session_update'
  | 'malformed_session_update'
  | 'failed'
  | 'closed';

export class AcpSessionError extends Error {
  readonly code: AcpSessionFailureCode;
  readonly details?: unknown;

  constructor(code: AcpSessionFailureCode, message = code, details?: unknown) {
    super(message);
    this.name = 'AcpSessionError';
    this.code = code;
    this.details = details;
  }
}

export type AcpSessionDiagnosticCode =
  | 'unexpected_update'
  | 'foreign_session_update'
  | 'malformed_session_update'
  | 'close_failed';

export type AcpSessionDiagnostic = {
  code: AcpSessionDiagnosticCode;
  message: string;
  details?: unknown;
};

export type AcpSessionUpdate = {
  sessionId: string;
  update: JsonRpcValue;
};

export type AcpSessionController = {
  initialize(): Promise<void>;
  create(): Promise<string>;
  configure(): Promise<void>;
  prompt(prompt: JsonRpcValue): Promise<JsonRpcValue>;
  receiveUpdate(params: unknown): Promise<void>;
  close(): Promise<void>;
  sessionId(): string | null;
};

export type CreateAcpSessionDeps = {
  connection: JsonRpcConnection;
  configure: (sessionId: string) => Promise<void>;
  onUpdate: (update: AcpSessionUpdate) => Promise<void>;
  onDiagnostic: (diagnostic: AcpSessionDiagnostic) => void;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonRpcValue(value: unknown): value is JsonRpcValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonRpcValue);
  return isRecord(value) && Object.values(value).every(isJsonRpcValue);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

@Injectable({ scope: Scope.TRANSIENT })
export class AcpSession implements AcpSessionController {
  private deps: CreateAcpSessionDeps | undefined;
  private state: State = 'new';
  private createdSessionId: string | null = null;
  private updateFailure: AcpSessionError | null = null;
  private createSettled: ReturnType<typeof deferred> | null = null;
  private configuring = false;
  private closeOperation: Promise<void> | null = null;
  private closeWireOperation: Promise<void> | null = null;

  bind(deps: CreateAcpSessionDeps): void {
    if (this.deps) throw new Error('ACP session is already bound');
    this.deps = deps;
  }

  private runtime(): CreateAcpSessionDeps {
    if (!this.deps) throw new Error('ACP session is not bound');
    return this.deps;
  }

  private diagnostic(code: AcpSessionDiagnosticCode, message: string, details?: unknown): void {
    try {
      this.runtime().onDiagnostic({ code, message, details });
    } catch {}
  }

  private unavailable(): never {
    if (this.state === 'closed' || this.state === 'closing') throw new AcpSessionError('closed');
    if (this.updateFailure) throw this.updateFailure;
    if (this.state === 'failed') throw new AcpSessionError('failed');
    throw new Error('ACP session is available');
  }

  private rejectTerminal(): void {
    if (this.state === 'closed' || this.state === 'closing' || this.state === 'failed') this.unavailable();
  }

  private fail(_error: unknown): void {
    if (this.state !== 'closing' && this.state !== 'closed') this.state = 'failed';
  }

  private isClosing(): boolean {
    return this.state === 'closing' || this.state === 'closed';
  }

  private async closeWire(): Promise<void> {
    if (!this.createdSessionId) return;
    if (this.closeWireOperation) return this.closeWireOperation;
    const sessionId = this.createdSessionId;
    this.closeWireOperation = this.runtime().connection.request('session/close', { sessionId })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.diagnostic('close_failed', 'ACP session close failed', error);
      });
    return this.closeWireOperation;
  }

  async initialize(): Promise<void> {
    this.rejectTerminal();
    if (this.state !== 'new') throw new AcpSessionError('initialize_already_started');
    this.state = 'initializing';
    try {
      const response = await this.runtime().connection.request('initialize', { protocolVersion: 1 });
      if (!isRecord(response) || response.protocolVersion !== 1) {
        const error = new AcpSessionError('invalid_protocol_version');
        this.fail(error);
        throw error;
      }
      if (!this.isClosing()) this.state = 'initialized';
    } catch (error) {
      if (error instanceof AcpSessionError) throw error;
      this.fail(error);
      throw error;
    }
  }

  async create(): Promise<string> {
    this.rejectTerminal();
    if (this.state !== 'initialized') throw new AcpSessionError('session_new_already_started');
    this.state = 'creating';
    this.createSettled = deferred();
    try {
      const response = await this.runtime().connection.request('session/new');
      if (!isRecord(response) || !Object.hasOwn(response, 'sessionId') ||
        typeof response.sessionId !== 'string' || response.sessionId.length === 0) {
        const error = new AcpSessionError('invalid_session_id');
        this.fail(error);
        throw error;
      }
      this.createdSessionId = response.sessionId;
      if (this.isClosing()) {
        await this.closeWire();
      } else {
        this.state = 'session-created';
      }
      return this.createdSessionId;
    } catch (error) {
      if (error instanceof AcpSessionError) throw error;
      this.fail(error);
      throw error;
    } finally {
      this.createSettled.resolve();
    }
  }

  async configure(): Promise<void> {
    this.rejectTerminal();
    if (this.state === 'new' || this.state === 'initializing' || this.state === 'initialized' || this.state === 'creating') {
      throw new AcpSessionError('configuration_before_session');
    }
    if (this.state !== 'session-created') throw new AcpSessionError('configuration_already_started');
    const sessionId = this.createdSessionId;
    if (!sessionId) throw new AcpSessionError('configuration_before_session');
    this.state = 'configured';
    this.configuring = true;
    try {
      await this.runtime().configure(sessionId);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.configuring = false;
    }
  }

  async prompt(promptValue: JsonRpcValue): Promise<JsonRpcValue> {
    this.rejectTerminal();
    if (this.configuring || this.state === 'new' || this.state === 'initializing' || this.state === 'initialized' || this.state === 'creating' || this.state === 'session-created') {
      throw new AcpSessionError('prompt_before_session');
    }
    if (this.state !== 'configured') throw new AcpSessionError('prompt_already_started');
    const sessionId = this.createdSessionId;
    if (!sessionId) throw new AcpSessionError('prompt_before_session');
    this.state = 'prompted';
    try {
      return await this.runtime().connection.request('session/prompt', { sessionId, prompt: promptValue });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async receiveUpdate(params: unknown): Promise<void> {
    this.rejectTerminal();
    if (this.state !== 'session-created' && this.state !== 'configured' && this.state !== 'prompted') {
      const error = new AcpSessionError('unexpected_update');
      this.updateFailure = error;
      this.state = 'failed';
      this.diagnostic('unexpected_update', 'Unexpected ACP session update', params);
      throw error;
    }
    if (!isRecord(params) || !Object.hasOwn(params, 'sessionId') || !Object.hasOwn(params, 'update') ||
      typeof params.sessionId !== 'string' || params.sessionId.length === 0 || !isJsonRpcValue(params.update)) {
      const error = new AcpSessionError('malformed_session_update');
      this.updateFailure = error;
      this.state = 'failed';
      this.diagnostic('malformed_session_update', 'Malformed ACP session update', params);
      throw error;
    }
    if (params.sessionId !== this.createdSessionId) {
      const error = new AcpSessionError('foreign_session_update');
      this.updateFailure = error;
      this.state = 'failed';
      this.diagnostic('foreign_session_update', 'Foreign ACP session update', params);
      throw error;
    }
    try {
      await this.runtime().onUpdate({ sessionId: params.sessionId, update: params.update });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.state = 'closing';
    this.closeOperation = (async () => {
      if (!this.createdSessionId && this.createSettled) await this.createSettled.promise;
      await this.closeWire();
      this.state = 'closed';
    })();
    return this.closeOperation;
  }

  sessionId(): string | null {
    return this.createdSessionId;
  }
}

export function createAcpSession(deps: CreateAcpSessionDeps): AcpSessionController {
  const session = new AcpSession();
  session.bind(deps);
  return session;
}
