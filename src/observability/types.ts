export type AgentLogStream = 'stdout' | 'stderr' | 'events' | 'combined';

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
  | 'VALIDATION_FAILURE';

export class AgentObservabilityError extends Error {
  constructor(
    public readonly code: AgentObservabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentObservabilityError';
  }
}
