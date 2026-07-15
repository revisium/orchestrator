import { Injectable, Scope } from '@nestjs/common';
import {
  ACP_METHODS,
  buildAcpCloseSessionParams,
  buildAcpInitializeParams,
  buildAcpNewSessionParams,
  buildAcpPromptParams,
  buildAcpSetSessionConfigOptionParams,
} from '../protocol/methods.js';
import {
  parseAcpCloseSessionResponse,
  parseAcpInitializeResponse,
  parseAcpPromptResponse,
  parseAcpSessionNewResponse,
  parseAcpSetSessionConfigOptionResponse,
} from '../protocol/index.js';
import type {
  AcpInitializeRequest,
  AcpInitializeResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPermissionRequest,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpSessionConfigOption,
  AcpSessionNotification,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
} from '../protocol/values.js';
import { AcpSessionError } from './error.js';
import { createDeferredPromise, snapshotSessionError } from './session.helpers.js';
import type {
  AcpSessionController,
  AcpSessionDependencies,
  AcpSessionDiagnosticCode,
} from './types.js';

type AcpSessionState =
  | 'new'
  | 'initializing'
  | 'initialized'
  | 'creating'
  | 'session-created'
  | 'configuring'
  | 'configured'
  | 'prompted'
  | 'failed'
  | 'closing'
  | 'closed';

@Injectable({ scope: Scope.TRANSIENT })
export class AcpSession implements AcpSessionController {
  private deps: AcpSessionDependencies | undefined;
  private state: AcpSessionState = 'new';
  private createdSessionId: string | null = null;
  private booleanConfigOptionsAdvertised = false;
  private closeAdvertised = false;
  private createOperationSettled: ReturnType<typeof createDeferredPromise<void>> | null = null;
  private closeOperation: Promise<void> | null = null;

  bind(deps: AcpSessionDependencies): void {
    if (this.deps) {
      throw new AcpSessionError('dependencies_already_bound', 'ACP session dependencies are already bound');
    }
    this.deps = deps;
  }

  async initialize(request: AcpInitializeRequest): Promise<AcpInitializeResponse> {
    const dependencies = this.dependencies();
    this.assertActive();
    if (this.state !== 'new') {
      throw new AcpSessionError('initialize_already_started', 'ACP initialization already started');
    }
    this.state = 'initializing';
    const booleanCapability = request.clientCapabilities.session.configOptions.boolean;
    this.booleanConfigOptionsAdvertised = booleanCapability != null;
    try {
      const rawResponse = await dependencies.connection.request(
        ACP_METHODS.initialize,
        buildAcpInitializeParams(request),
      );
      const response = parseAcpInitializeResponse(rawResponse);
      this.closeAdvertised =
        response.agentCapabilities?.sessionCapabilities?.close != null;
      if (!this.isClosingOrClosed()) this.state = 'initialized';
      return response;
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async create(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    const dependencies = this.dependencies();
    this.assertActive();
    if (this.state !== 'initialized') {
      throw new AcpSessionError('session_new_already_started', 'ACP session creation already started');
    }
    this.state = 'creating';
    this.createOperationSettled = createDeferredPromise<void>();
    try {
      const rawResponse = await dependencies.connection.request(
        ACP_METHODS.newSession,
        buildAcpNewSessionParams(request),
      );
      const response = parseAcpSessionNewResponse(rawResponse);
      this.createdSessionId = response.sessionId;
      this.validateConfigOptions(response.configOptions ?? []);
      if (!this.isClosingOrClosed()) this.state = 'session-created';
      return response;
    } catch (error) {
      this.markFailed(error);
      throw error;
    } finally {
      this.createOperationSettled.resolve();
    }
  }

  async configure(operation: () => Promise<void>): Promise<void> {
    this.dependencies();
    this.assertActive();
    if (this.state === 'new' || this.state === 'initializing' ||
        this.state === 'initialized' || this.state === 'creating') {
      throw new AcpSessionError('configuration_before_session', 'ACP configuration requires a session');
    }
    if (this.state !== 'session-created') {
      throw new AcpSessionError('configuration_already_started', 'ACP configuration already started');
    }
    this.state = 'configuring';
    try {
      await operation();
      if (!this.isClosingOrClosed()) this.state = 'configured';
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async setConfigOption(
    request: AcpSetSessionConfigOptionRequest,
  ): Promise<AcpSetSessionConfigOptionResponse> {
    const dependencies = this.dependencies();
    this.assertActive();
    if (this.state !== 'configuring') {
      throw new AcpSessionError(
        'set_config_option_outside_configuration',
        'ACP config options can only be set during configuration',
      );
    }
    if (request.sessionId !== this.createdSessionId) {
      throw new AcpSessionError('foreign_session_config_option', 'ACP config option targets another session');
    }
    try {
      const rawResponse = await dependencies.connection.request(
        ACP_METHODS.setSessionConfigOption,
        buildAcpSetSessionConfigOptionParams(request),
      );
      const response = parseAcpSetSessionConfigOptionResponse(rawResponse);
      this.validateConfigOptions(response.configOptions);
      return response;
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async prompt(request: AcpPromptRequest): Promise<AcpPromptResponse> {
    const dependencies = this.dependencies();
    this.assertActive();
    if (this.state === 'new' || this.state === 'initializing' ||
        this.state === 'initialized' || this.state === 'creating' ||
        this.state === 'session-created' || this.state === 'configuring') {
      throw new AcpSessionError('prompt_before_session', 'ACP prompt requires configuration');
    }
    if (this.state !== 'configured') {
      throw new AcpSessionError('prompt_already_started', 'ACP prompt already started');
    }
    if (request.sessionId !== this.createdSessionId) {
      throw new AcpSessionError('foreign_session_prompt', 'ACP prompt targets another session');
    }
    this.state = 'prompted';
    try {
      const rawResponse = await dependencies.connection.request(
        ACP_METHODS.prompt,
        buildAcpPromptParams(request),
      );
      return parseAcpPromptResponse(rawResponse);
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async receiveUpdate(notification: AcpSessionNotification): Promise<void> {
    const dependencies = this.dependencies();
    this.assertActive();
    if (this.state !== 'session-created' && this.state !== 'configuring' &&
        this.state !== 'configured' && this.state !== 'prompted') {
      const error = new AcpSessionError('unexpected_update', 'Unexpected ACP session update');
      this.markFailed(error);
      this.reportDiagnostic('unexpected_update', 'Unexpected ACP session update');
      throw error;
    }
    if (notification.sessionId !== this.createdSessionId) {
      const error = new AcpSessionError('foreign_session_update', 'ACP update targets another session');
      this.markFailed(error);
      this.reportDiagnostic('foreign_session_update', 'Foreign ACP session update');
      throw error;
    }
    if (notification.update.kind === 'activity' &&
        notification.update.activityKind === 'config_option_update') {
      this.validateConfigOptions(notification.update.configOptions);
    }
    try {
      await dependencies.onUpdate(notification);
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  assertPermissionRequest(request: AcpPermissionRequest): void {
    this.dependencies();
    this.assertActive();
    if (this.state !== 'session-created' && this.state !== 'configuring' &&
        this.state !== 'configured' && this.state !== 'prompted') {
      throw new AcpSessionError(
        'permission_request_before_session',
        'ACP permission request requires a session',
      );
    }
    if (request.sessionId !== this.createdSessionId) {
      throw new AcpSessionError('foreign_session_request', 'ACP request targets another session');
    }
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.state = 'closing';
    this.closeOperation = this.closeSession();
    return this.closeOperation;
  }

  getSessionId(): string | null {
    return this.createdSessionId;
  }

  private dependencies(): AcpSessionDependencies {
    if (!this.deps) {
      throw new AcpSessionError('dependencies_not_bound', 'ACP session dependencies are not bound');
    }
    return this.deps;
  }

  private assertActive(): void {
    if (this.isClosingOrClosed()) {
      throw new AcpSessionError('closed', 'ACP session is closed');
    }
    if (this.state === 'failed') {
      throw new AcpSessionError('failed', 'ACP session failed');
    }
  }

  private isClosingOrClosed(): boolean {
    return this.state === 'closing' || this.state === 'closed';
  }

  private markFailed(_error: unknown): void {
    if (!this.isClosingOrClosed()) this.state = 'failed';
  }

  private validateConfigOptions(configOptions: readonly AcpSessionConfigOption[]): void {
    if (this.booleanConfigOptionsAdvertised ||
        configOptions.every((option) => option.type !== 'boolean')) return;
    const error = new AcpSessionError(
      'failed',
      'ACP peer returned a boolean config option without advertised client capability',
    );
    this.markFailed(error);
    throw error;
  }

  private async closeSession(): Promise<void> {
    try {
      if (!this.createdSessionId && this.createOperationSettled) {
        await this.createOperationSettled.promise;
      }
      if (!this.createdSessionId || !this.closeAdvertised) return;
      const response = await this.dependencies().connection.request(
        ACP_METHODS.closeSession,
        buildAcpCloseSessionParams({ sessionId: this.createdSessionId }),
      );
      parseAcpCloseSessionResponse(response);
    } catch (error) {
      this.reportDiagnostic('close_failed', 'ACP session close failed', error);
    } finally {
      this.state = 'closed';
    }
  }

  private reportDiagnostic(
    code: AcpSessionDiagnosticCode,
    message: string,
    details?: unknown,
  ): void {
    try {
      this.dependencies().onDiagnostic({
        code,
        message,
        ...(details === undefined ? {} : { details: snapshotSessionError(details) }),
      });
    } catch {}
  }
}

export function createAcpSession(deps: AcpSessionDependencies): AcpSessionController {
  const session = new AcpSession();
  session.bind(deps);
  return session;
}
