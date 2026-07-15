import type {
  JsonRpcConnection,
  JsonRpcServerRequestOutcome,
} from "../jsonrpc/connection.types.js";
import type { JsonRpcParams, JsonRpcRequest } from "../jsonrpc/types.js";
import {
  AcpPermissionRequestHandler,
  type AcpPermissionResolver,
} from "../prompt-execution/permission-request-handler.js";
import {
  AcpPromptOutcomeCollector,
  type AcpPromptOutcome,
} from "../prompt-execution/prompt-outcome-collector.js";
import type { AcpPromptExecutionDiagnostic } from "../prompt-execution/diagnostic.js";
import { AcpProtocolError } from "../protocol/error.js";
import { ACP_METHODS, buildAcpPermissionResult } from "../protocol/methods.js";
import {
  parseAcpPeerNotification,
  parseAcpPeerRequest,
} from "../protocol/parser.js";
import type {
  AcpImplementation,
  AcpSessionNotification,
} from "../protocol/values.js";
import { AcpSessionError } from "../session/error.js";
import { AcpSession } from "../session/session.js";
import type { AcpSessionDiagnostic } from "../session/types.js";
import type { AcpConnector } from "./connector.js";

export type AcpInboundNotification = Readonly<{
  method: string;
  params?: JsonRpcParams;
}>;
export type AcpInboundHandlers = Readonly<{
  onRequest(request: JsonRpcRequest): Promise<JsonRpcServerRequestOutcome>;
  onNotification(notification: AcpInboundNotification): Promise<void>;
}>;
export type AcpOpenConnection = (
  handlers: AcpInboundHandlers,
) => Promise<AcpOpenedConnection>;
export type AcpOpenedConnection = Readonly<{
  connection: JsonRpcConnection;
  inboundFailure: Promise<Error>;
  start(): void;
  completionBarrier(): Promise<void>;
}>;
export type AcpInvocationRequest = Readonly<{
  cwd: string;
  prompt: string;
  clientInfo: AcpImplementation;
}>;

export type AcpDiagnosticScalar = string | number | boolean | null;
export type AcpDiagnosticDetails =
  | AcpDiagnosticScalar
  | readonly AcpDiagnosticDetails[]
  | Readonly<{ [key: string]: AcpDiagnosticDetails }>;
export type AcpInvocationFailureCode =
  | "permission_request_after_terminal"
  | "session_update_after_terminal"
  | "terminal_outcome_unavailable";

export class AcpInvocationError extends Error {
  readonly code: AcpInvocationFailureCode;
  readonly details?: AcpDiagnosticDetails;

  constructor(
    code: AcpInvocationFailureCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AcpInvocationError";
    this.code = code;
    this.details =
      details === undefined
        ? undefined
        : normalizeAcpDiagnosticDetails(details);
  }
}

export type AcpInvocationProtocolDiagnosticCode =
  | "unsupported_protocol_version"
  | "invalid_initialize_response"
  | "invalid_session_new_response"
  | "invalid_config_option_response"
  | "invalid_prompt_response"
  | "invalid_close_response"
  | "malformed_peer_request"
  | "malformed_peer_notification"
  | "unsupported_peer_request"
  | "unsupported_peer_notification"
  | "unsupported_session_update";
export type AcpInvocationSessionDiagnosticCode =
  | "dependencies_not_bound"
  | "dependencies_already_bound"
  | "initialize_already_started"
  | "session_new_already_started"
  | "configuration_before_session"
  | "configuration_already_started"
  | "set_config_option_outside_configuration"
  | "foreign_session_config_option"
  | "prompt_before_session"
  | "prompt_already_started"
  | "foreign_session_prompt"
  | "unexpected_update"
  | "foreign_session_update"
  | "permission_request_before_session"
  | "foreign_session_request"
  | "failed"
  | "closed"
  | "close_failed";
export type AcpInvocationRuntimeDiagnosticCode =
  | "session_update_observer_failed"
  | "connection_failed_after_terminal";
export type AcpInvocationDiagnostic =
  | Readonly<{
      source: "protocol";
      code: AcpInvocationProtocolDiagnosticCode;
      message: string;
      details?: AcpDiagnosticDetails;
    }>
  | Readonly<{
      source: "session";
      code: AcpInvocationSessionDiagnosticCode;
      message: string;
      details?: AcpDiagnosticDetails;
    }>
  | Readonly<{
      source: "prompt-execution";
      code: "prompt_execution_diagnostic";
      message: string;
      details?: AcpDiagnosticDetails;
    }>
  | Readonly<{
      source: "runtime";
      code: AcpInvocationRuntimeDiagnosticCode;
      message: string;
      details?: AcpDiagnosticDetails;
    }>;

export type AcpInvocationDependencies = Readonly<{
  openConnection: AcpOpenConnection;
  connector: AcpConnector;
  resolvePermission: AcpPermissionResolver;
  onSessionUpdate?: (notification: AcpSessionNotification) => void;
  onDiagnostic(diagnostic: AcpInvocationDiagnostic): void;
}>;
export type AcpInvocationComponents = Readonly<{
  session: AcpSession;
  permissionHandler: AcpPermissionRequestHandler;
  outcomeCollector: AcpPromptOutcomeCollector;
}>;

const MAX_DIAGNOSTIC_DEPTH = 4;
const MAX_DIAGNOSTIC_ENTRIES = 32;
const MAX_DIAGNOSTIC_STRING_LENGTH = 512;

export function normalizeAcpDiagnosticDetails(
  input: unknown,
): AcpDiagnosticDetails {
  try {
    return freezeDiagnostic(
      normalizeDiagnosticValue(input, 0, new WeakSet<object>()),
    );
  } catch {
    return Object.freeze({ kind: "unsupported", type: "uninspectable" });
  }
}

function normalizeDiagnosticValue(
  input: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): AcpDiagnosticDetails {
  if (typeof input === "string")
    return input.length <= MAX_DIAGNOSTIC_STRING_LENGTH
      ? input
      : { kind: "truncated", reason: "string" };
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number")
    return Number.isFinite(input)
      ? input
      : { kind: "non_finite_number", value: String(input) };
  if (input instanceof Error) return normalizeError(input);
  if (typeof input !== "object")
    return { kind: "unsupported", type: typeof input };
  if (depth >= MAX_DIAGNOSTIC_DEPTH)
    return { kind: "truncated", reason: "depth" };
  if (ancestors.has(input)) return { kind: "truncated", reason: "cycle" };
  ancestors.add(input);
  try {
    if (Array.isArray(input)) return normalizeArray(input, depth, ancestors);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      return { kind: "unsupported", type: "object" };
    return normalizeRecord(input, depth, ancestors);
  } finally {
    ancestors.delete(input);
  }
}

function normalizeError(error: Error): AcpDiagnosticDetails {
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const ownName = descriptors["name"];
  const ownMessage = descriptors["message"];
  const name =
    ownName && "value" in ownName && typeof ownName.value === "string"
      ? normalizeDiagnosticValue(ownName.value, 1, new WeakSet<object>())
      : "Error";
  const message =
    ownMessage && "value" in ownMessage && typeof ownMessage.value === "string"
      ? normalizeDiagnosticValue(ownMessage.value, 1, new WeakSet<object>())
      : "";
  return { name, message };
}

function normalizeArray(
  input: unknown[],
  depth: number,
  ancestors: WeakSet<object>,
): AcpDiagnosticDetails {
  const descriptor = Object.getOwnPropertyDescriptor(input, "length");
  const length =
    descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!Number.isSafeInteger(length) || typeof length !== "number" || length < 0)
    return { kind: "unsupported", type: "array" };
  if (length > MAX_DIAGNOSTIC_ENTRIES)
    return { kind: "truncated", reason: "entries" };
  const normalized: AcpDiagnosticDetails[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(input, String(index));
    if (!item || !item.enumerable || !("value" in item))
      return { kind: "unsupported", type: "array" };
    normalized.push(normalizeDiagnosticValue(item.value, depth + 1, ancestors));
  }
  const unexpected = Reflect.ownKeys(input).find((key) => {
    if (key === "length") return false;
    if (typeof key !== "string") return true;
    const index = Number(key);
    return (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key
    );
  });
  return unexpected === undefined
    ? normalized
    : { kind: "unsupported", type: "array" };
}

function normalizeRecord(
  input: object,
  depth: number,
  ancestors: WeakSet<object>,
): AcpDiagnosticDetails {
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string"))
    return { kind: "unsupported", type: "symbol_key" };
  const enumerable = keys
    .filter(
      (key): key is string =>
        typeof key === "string" &&
        Object.getOwnPropertyDescriptor(input, key)?.enumerable === true,
    )
    .sort();
  if (enumerable.length > MAX_DIAGNOSTIC_ENTRIES)
    return { kind: "truncated", reason: "entries" };
  const normalized: Record<string, AcpDiagnosticDetails> = {};
  for (const key of enumerable) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    normalized[key] =
      descriptor && "value" in descriptor
        ? normalizeDiagnosticValue(descriptor.value, depth + 1, ancestors)
        : { kind: "unsupported", type: "accessor" };
  }
  return normalized;
}

function freezeDiagnostic(details: AcpDiagnosticDetails): AcpDiagnosticDetails {
  if (details !== null && typeof details === "object") {
    for (const nested of Object.values(details)) freezeDiagnostic(nested);
    Object.freeze(details);
  }
  return details;
}

type FailureLatch = Readonly<{
  signal: Promise<Error>;
  get(): Error | undefined;
  latch(error: Error): void;
}>;
function createFailureLatch(): FailureLatch {
  let first: Error | undefined;
  let resolve!: (error: Error) => void;
  const signal = new Promise<Error>((next) => {
    resolve = next;
  });
  return {
    signal,
    get: () => first,
    latch(error) {
      if (first) return;
      first = error;
      resolve(error);
    },
  };
}
function asError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
  } catch {}
  return new Error("ACP operation failed with a non-Error value");
}
function raceFailure<T>(
  operation: Promise<T>,
  latch: FailureLatch,
): Promise<T> {
  return Promise.race([
    operation,
    latch.signal.then((error) => Promise.reject(error)),
  ]);
}

function reportDiagnostic(
  callback: AcpInvocationDependencies["onDiagnostic"],
  diagnostic: AcpInvocationDiagnostic,
): void {
  try {
    callback(
      Object.freeze({
        ...diagnostic,
        ...(diagnostic.details === undefined
          ? {}
          : { details: normalizeAcpDiagnosticDetails(diagnostic.details) }),
      }),
    );
  } catch {}
}
function reportSessionDiagnostic(
  callback: AcpInvocationDependencies["onDiagnostic"],
  diagnostic: AcpSessionDiagnostic,
): void {
  reportDiagnostic(callback, {
    source: "session",
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.details === undefined
      ? {}
      : { details: normalizeAcpDiagnosticDetails(diagnostic.details) }),
  });
}
function reportPromptDiagnostic(
  callback: AcpInvocationDependencies["onDiagnostic"],
  diagnostic: AcpPromptExecutionDiagnostic,
): void {
  reportDiagnostic(callback, {
    source: "prompt-execution",
    code: "prompt_execution_diagnostic",
    message: diagnostic.message,
    details: normalizeAcpDiagnosticDetails({
      reason: diagnostic.reason,
      severity: diagnostic.severity,
    }),
  });
}

function createInboundHandlers(
  deps: AcpInvocationDependencies,
  components: AcpInvocationComponents,
  latch: FailureLatch,
  isTerminal: () => boolean,
): AcpInboundHandlers &
  Readonly<{
    onParsedSessionUpdate(notification: AcpSessionNotification): Promise<void>;
  }> {
  const onParsedSessionUpdate = async (
    notification: AcpSessionNotification,
  ): Promise<void> => {
    const { sessionId, update } = notification;
    if (update.kind === "agent-text") {
      const result = components.outcomeCollector.collect({
        kind: "agent-text",
        sessionId,
        text: update.text,
      });
      if (result.outcome === "rejected")
        throw new AcpInvocationError(
          "session_update_after_terminal",
          "ACP session update was rejected after terminal outcome",
          result,
        );
    } else if (update.kind === "usage") {
      const result = components.outcomeCollector.collect({
        kind: "usage",
        sessionId,
        used: update.used,
        size: update.size,
        ...(update.reportedCost === undefined
          ? {}
          : { reportedCost: update.reportedCost }),
      });
      if (result.outcome === "rejected")
        throw new AcpInvocationError(
          "session_update_after_terminal",
          "ACP usage update was rejected after terminal outcome",
          result,
        );
    }
    if (deps.onSessionUpdate) {
      try {
        deps.onSessionUpdate(notification);
      } catch (error) {
        reportDiagnostic(deps.onDiagnostic, {
          source: "runtime",
          code: "session_update_observer_failed",
          message: "ACP session update observer failed",
          details: normalizeAcpDiagnosticDetails(error),
        });
      }
    }
  };
  const onNotification = async (
    notification: AcpInboundNotification,
  ): Promise<void> => {
    try {
      const parsed = parseAcpPeerNotification(notification);
      if (isTerminal())
        throw new AcpInvocationError(
          "session_update_after_terminal",
          "ACP session update arrived after terminal outcome",
        );
      await components.session.receiveUpdate(parsed);
    } catch (error) {
      const failure = asError(error);
      latch.latch(failure);
      throw failure;
    }
  };
  const onRequest = async (
    request: JsonRpcRequest,
  ): Promise<JsonRpcServerRequestOutcome> => {
    try {
      const permission = parseAcpPeerRequest(request);
      if (isTerminal()) {
        latch.latch(
          new AcpInvocationError(
            "permission_request_after_terminal",
            "ACP permission request arrived after terminal outcome",
          ),
        );
        return {
          kind: "result",
          value: buildAcpPermissionResult({
            outcome: { outcome: "cancelled" },
          }),
        };
      }
      components.session.assertPermissionRequest(permission);
      const handling = await components.permissionHandler.handle(permission);
      if (handling.outcome === "cancelled")
        for (const diagnostic of handling.diagnostics) {
          components.outcomeCollector.collect({
            kind: "diagnostic",
            sessionId: permission.sessionId,
            diagnostic,
          });
          reportPromptDiagnostic(deps.onDiagnostic, diagnostic);
        }
      return {
        kind: "result",
        value: buildAcpPermissionResult(handling.response),
      };
    } catch (error) {
      const failure = asError(error);
      latch.latch(failure);
      if (failure instanceof AcpProtocolError) {
        const unsupported = failure.code === "unsupported_peer_request";
        return {
          kind: "error",
          error: {
            code: unsupported ? -32601 : -32602,
            message: unsupported ? "Method not found" : "Invalid params",
          },
        };
      }
      if (failure instanceof AcpSessionError)
        return {
          kind: "result",
          value: buildAcpPermissionResult({
            outcome: { outcome: "cancelled" },
          }),
        };
      return {
        kind: "error",
        error: { code: -32603, message: "Internal error" },
      };
    }
  };
  return { onRequest, onNotification, onParsedSessionUpdate };
}

export async function runAcpInvocationWithComponents(
  request: AcpInvocationRequest,
  deps: AcpInvocationDependencies,
  components: AcpInvocationComponents,
): Promise<AcpPromptOutcome> {
  const latch = createFailureLatch();
  let terminalReceived = false;
  let completionCommitted = false;
  let sessionBound = false;
  const handlers = createInboundHandlers(
    deps,
    components,
    latch,
    () => terminalReceived,
  );
  const opened = await deps.openConnection(handlers);
  const settleInboundFailure = (error: unknown): void => {
    const failure = asError(error);
    if (completionCommitted) {
      reportDiagnostic(deps.onDiagnostic, {
        source: "runtime",
        code: "connection_failed_after_terminal",
        message: "ACP connection failed after terminal outcome",
        details: normalizeAcpDiagnosticDetails(failure),
      });
    } else latch.latch(failure);
  };
  const consumed = opened.inboundFailure.then(
    settleInboundFailure,
    settleInboundFailure,
  );
  void consumed.catch(() => undefined);
  const sessionConnection: JsonRpcConnection = {
    async request(method, params) {
      const response = await opened.connection.request(method, params);
      if (method === ACP_METHODS.prompt) terminalReceived = true;
      return response;
    },
    notify: (method, params) => opened.connection.notify(method, params),
    receive: (message) => opened.connection.receive(message),
    close: () => opened.connection.close(),
  };
  components.session.bind({
    connection: sessionConnection,
    onUpdate: handlers.onParsedSessionUpdate,
    onDiagnostic: (diagnostic) =>
      reportSessionDiagnostic(deps.onDiagnostic, diagnostic),
  });
  sessionBound = true;
  components.permissionHandler.bind({
    resolvePermission: deps.resolvePermission,
  });
  try {
    opened.start();
    const initialization = await raceFailure(
      components.session.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          session: { configOptions: { boolean: {} } },
          terminal: false,
        },
        clientInfo: request.clientInfo,
      }),
      latch,
    );
    const created = await raceFailure(
      components.session.create({ cwd: request.cwd, mcpServers: [] }),
      latch,
    );
    components.outcomeCollector.bind({ expectedSessionId: created.sessionId });
    await raceFailure(
      components.session.configure(async () =>
        deps.connector.configure({
          initialization,
          session: created,
          setConfigOption: (configRequest) =>
            components.session.setConfigOption(configRequest),
        }),
      ),
      latch,
    );
    const promptResponse = await raceFailure(
      components.session.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      }),
      latch,
    );
    components.outcomeCollector.complete({
      sessionId: created.sessionId,
      stopReason: promptResponse.stopReason,
    });
    const terminal = components.outcomeCollector.outcome();
    if (terminal.outcome === "unavailable")
      throw new AcpInvocationError(
        "terminal_outcome_unavailable",
        "ACP prompt terminal outcome is unavailable",
      );
    await raceFailure(opened.completionBarrier(), latch);
    const barrierFailure = latch.get();
    if (barrierFailure) throw barrierFailure;
    completionCommitted = true;
    return terminal.value;
  } finally {
    if (sessionBound) void components.session.close();
  }
}

export function runAcpInvocation(
  request: AcpInvocationRequest,
  deps: AcpInvocationDependencies,
): Promise<AcpPromptOutcome> {
  return runAcpInvocationWithComponents(request, deps, {
    session: new AcpSession(),
    permissionHandler: new AcpPermissionRequestHandler(),
    outcomeCollector: new AcpPromptOutcomeCollector(),
  });
}
