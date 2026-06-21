export type AgentLogStream = 'stdout' | 'stderr' | 'events' | 'combined';
export type AgentOutputStream = 'stdout' | 'stderr' | 'agent-jsonl';
export type AgentOutputEventKind = 'activity' | 'output' | 'parsed_event' | 'status';
export type AgentActivityStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'permission_blocked'
  | 'cancelled'
  | 'exited'
  | 'timed_out'
  | 'failed';

export const AGENT_ACTIVITY_EVENT_KEY = 'agent-activity';
export const AGENT_OUTPUT_STREAM_KEY = 'agent-output';

export type AgentAttemptSummary = {
  runId: string;
  attemptId: string;
  stepId: string;
  stepKey?: string;
  role: string;
  runner: string;
  artifactRef: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  exitCode?: number | null;
  timedOut?: boolean;
  stdoutBytes: number;
  stderrBytes: number;
};

export type AgentRunActivity = {
  runId: string;
  aggregateStatus: AgentActivityStatus;
  latestActivityAt: string;
  latestOutputAt?: string;
  attempts: AgentActivitySnapshot[];
};

export type AgentActivitySnapshot = {
  runId: string;
  attemptId: string;
  stepId: string;
  stepKey?: string;
  role: string;
  runner: string;
  pid?: number;
  status: AgentActivityStatus;
  startedAt: string;
  lastEventAt: string;
  lastOutputAt?: string;
  lastStream?: AgentOutputStream;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
  artifactRef: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
};

export type AgentOutputEvent = {
  cursor: string;
  runId: string;
  attemptId: string;
  attemptSeq?: number;
  stepId: string;
  stepKey?: string;
  at: string;
  kind: AgentOutputEventKind;
  stream?: AgentOutputStream;
  bytes?: number;
  outputOffsetBytes?: number;
  preview?: string;
  parsedType?: string;
  statusHint?: AgentActivityStatus;
  snapshot?: AgentActivitySnapshot;
};

export type ReadAgentOutputEventsInput = {
  runId: string;
  cursor?: string;
  limit?: number;
  timeoutMs?: number;
};

export type WatchAgentOutputInput = {
  runId: string;
  cursor?: string;
};

export type ReadAgentOutputEventsResult = {
  runId: string;
  events: AgentOutputEvent[];
  nextCursor?: string;
  cursorExpired: boolean;
};

export type AgentLogChunk = {
  runId: string;
  attemptId: string;
  stream: AgentLogStream;
  offsetBytes: number;
  nextOffsetBytes?: number;
  totalBytes?: number;
  truncated: boolean;
  content: string;
};

export type AgentLogMeta = {
  ref?: unknown;
  runId?: unknown;
  attemptId?: unknown;
  stepId?: unknown;
  stepKey?: unknown;
  role?: unknown;
  runner?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  status?: unknown;
  exitCode?: unknown;
  code?: unknown;
  timedOut?: unknown;
  error?: unknown;
};

export type AgentObservabilityErrorCode =
  | 'RUN_NOT_FOUND'
  | 'NO_AGENT_ATTEMPT_AVAILABLE'
  | 'VALIDATION_FAILURE'
  | 'DBOS_STREAM_UNAVAILABLE'
  | 'STREAM_CURSOR_EXPIRED';

export class AgentObservabilityError extends Error {
  constructor(
    public readonly code: AgentObservabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentObservabilityError';
  }
}
