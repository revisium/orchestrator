import type { NewStep, CostRecord, Step } from '../control-plane/steps.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { AgentActivityReporter } from '../observability/agent-activity-reporter.js';
import type { RunnerTimeoutEvidence, RunnerTimeoutFailureKind } from './process-executor.js';

export type NewStepSpec = Omit<NewStep, 'runId'>;

export type AttemptResult = {
  output: unknown;
  /** The agent's explicit routing verdict from structured output. The data-driven engine routes a
   *  `choice`/gate on this DOMAIN label and never mines prose output. */
  verdict?: string;
  artifacts?: unknown;
  nextSteps: NewStepSpec[];
  costs: CostRecord[];
  needsHuman?: boolean;
  lesson?: string;
};

export type RunAgent = (args: {
  role: Role;
  profile: ModelProfile;
  context: string;
  attemptId: string;
  step: Step;
  reporter?: AgentActivityReporter;
}) => Promise<AttemptResult>;

export class RunAgentError extends Error {
  readonly artifacts?: unknown;
  readonly failureKind?: RunnerTimeoutFailureKind;
  readonly retryableCandidate?: boolean;
  readonly timing?: RunnerTimeoutEvidence;

  constructor(
    message: string,
    artifacts?: unknown,
    metadata: {
      failureKind?: RunnerTimeoutFailureKind;
      retryableCandidate?: boolean;
      timing?: RunnerTimeoutEvidence;
    } = {},
  ) {
    super(message);
    this.name = 'RunAgentError';
    this.artifacts = artifacts;
    this.failureKind = metadata.failureKind;
    this.retryableCandidate = metadata.retryableCandidate;
    this.timing = metadata.timing;
  }
}

export function artifactsFromRunAgentError(err: unknown): unknown {
  return err instanceof RunAgentError ? err.artifacts : undefined;
}

export function failureMetadataFromRunAgentError(err: unknown): {
  failureKind?: RunnerTimeoutFailureKind;
  retryableCandidate?: boolean;
  timing?: RunnerTimeoutEvidence;
} {
  if (!(err instanceof RunAgentError)) return {};
  return {
    ...(err.failureKind ? { failureKind: err.failureKind } : {}),
    ...(err.retryableCandidate === undefined ? {} : { retryableCandidate: err.retryableCandidate }),
    ...(err.timing ? { timing: err.timing } : {}),
  };
}
