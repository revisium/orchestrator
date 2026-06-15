import type { NewStep, CostRecord, Step } from '../control-plane/steps.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';

export type NewStepSpec = Omit<NewStep, 'runId'>;

export type AttemptResult = {
  output: unknown;
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
}) => Promise<AttemptResult>;

export class RunAgentError extends Error {
  readonly artifacts?: unknown;

  constructor(message: string, artifacts?: unknown) {
    super(message);
    this.name = 'RunAgentError';
    this.artifacts = artifacts;
  }
}

export function artifactsFromRunAgentError(err: unknown): unknown {
  return err instanceof RunAgentError ? err.artifacts : undefined;
}
