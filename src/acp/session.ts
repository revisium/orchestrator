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

export type AcpSession = {
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

export function createAcpSession(deps: CreateAcpSessionDeps): AcpSession {
  let state: State = 'new';
  let createdSessionId: string | null = null;
  let updateFailure: AcpSessionError | null = null;
  let createSettled: ReturnType<typeof deferred> | null = null;
  let configuring = false;
  let closeOperation: Promise<void> | null = null;
  let closeWireOperation: Promise<void> | null = null;

  function diagnostic(code: AcpSessionDiagnosticCode, message: string, details?: unknown): void {
    try {
      deps.onDiagnostic({ code, message, details });
    } catch {}
  }

  function unavailable(): never {
    if (state === 'closed' || state === 'closing') throw new AcpSessionError('closed');
    if (updateFailure) throw updateFailure;
    if (state === 'failed') throw new AcpSessionError('failed');
    throw new Error('ACP session is available');
  }

  function rejectTerminal(): void {
    if (state === 'closed' || state === 'closing' || state === 'failed') unavailable();
  }

  function fail(_error: unknown): void {
    if (state !== 'closing' && state !== 'closed') state = 'failed';
  }

  function isClosing(): boolean {
    return state === 'closing' || state === 'closed';
  }

  async function closeWire(): Promise<void> {
    if (!createdSessionId) return;
    if (closeWireOperation) return closeWireOperation;
    const sessionId = createdSessionId;
    closeWireOperation = deps.connection.request('session/close', { sessionId })
      .then(() => undefined)
      .catch((error: unknown) => {
        diagnostic('close_failed', 'ACP session close failed', error);
      });
    return closeWireOperation;
  }

  async function initialize(): Promise<void> {
    rejectTerminal();
    if (state !== 'new') throw new AcpSessionError('initialize_already_started');
    state = 'initializing';
    try {
      const response = await deps.connection.request('initialize', { protocolVersion: 1 });
      if (!isRecord(response) || response.protocolVersion !== 1) {
        const error = new AcpSessionError('invalid_protocol_version');
        fail(error);
        throw error;
      }
      if (!isClosing()) state = 'initialized';
    } catch (error) {
      if (error instanceof AcpSessionError) throw error;
      fail(error);
      throw error;
    }
  }

  async function create(): Promise<string> {
    rejectTerminal();
    if (state !== 'initialized') throw new AcpSessionError('session_new_already_started');
    state = 'creating';
    createSettled = deferred();
    try {
      const response = await deps.connection.request('session/new');
      if (!isRecord(response) || !Object.hasOwn(response, 'sessionId') ||
        typeof response.sessionId !== 'string' || response.sessionId.length === 0) {
        const error = new AcpSessionError('invalid_session_id');
        fail(error);
        throw error;
      }
      createdSessionId = response.sessionId;
      if (isClosing()) {
        await closeWire();
      } else {
        state = 'session-created';
      }
      return createdSessionId;
    } catch (error) {
      if (error instanceof AcpSessionError) throw error;
      fail(error);
      throw error;
    } finally {
      createSettled.resolve();
    }
  }

  async function configure(): Promise<void> {
    rejectTerminal();
    if (state === 'new' || state === 'initializing' || state === 'initialized' || state === 'creating') {
      throw new AcpSessionError('configuration_before_session');
    }
    if (state !== 'session-created') throw new AcpSessionError('configuration_already_started');
    const sessionId = createdSessionId;
    if (!sessionId) throw new AcpSessionError('configuration_before_session');
    state = 'configured';
    configuring = true;
    try {
      await deps.configure(sessionId);
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      configuring = false;
    }
  }

  async function prompt(promptValue: JsonRpcValue): Promise<JsonRpcValue> {
    rejectTerminal();
    if (configuring || state === 'new' || state === 'initializing' || state === 'initialized' || state === 'creating' || state === 'session-created') {
      throw new AcpSessionError('prompt_before_session');
    }
    if (state !== 'configured') throw new AcpSessionError('prompt_already_started');
    const sessionId = createdSessionId;
    if (!sessionId) throw new AcpSessionError('prompt_before_session');
    state = 'prompted';
    try {
      return await deps.connection.request('session/prompt', { sessionId, prompt: promptValue });
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  async function receiveUpdate(params: unknown): Promise<void> {
    rejectTerminal();
    if (state !== 'session-created' && state !== 'configured' && state !== 'prompted') {
      const error = new AcpSessionError('unexpected_update');
      updateFailure = error;
      state = 'failed';
      diagnostic('unexpected_update', 'Unexpected ACP session update', params);
      throw error;
    }
    if (!isRecord(params) || !Object.hasOwn(params, 'sessionId') || !Object.hasOwn(params, 'update') ||
      typeof params.sessionId !== 'string' || params.sessionId.length === 0 || !isJsonRpcValue(params.update)) {
      const error = new AcpSessionError('malformed_session_update');
      updateFailure = error;
      state = 'failed';
      diagnostic('malformed_session_update', 'Malformed ACP session update', params);
      throw error;
    }
    if (params.sessionId !== createdSessionId) {
      const error = new AcpSessionError('foreign_session_update');
      updateFailure = error;
      state = 'failed';
      diagnostic('foreign_session_update', 'Foreign ACP session update', params);
      throw error;
    }
    try {
      await deps.onUpdate({ sessionId: params.sessionId, update: params.update });
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  function close(): Promise<void> {
    if (closeOperation) return closeOperation;
    state = 'closing';
    closeOperation = (async () => {
      if (!createdSessionId && createSettled) await createSettled.promise;
      await closeWire();
      state = 'closed';
    })();
    return closeOperation;
  }

  return { initialize, create, configure, prompt, receiveUpdate, close, sessionId: () => createdSessionId };
}
