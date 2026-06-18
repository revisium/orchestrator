import type { NewStep, CostRecord, Step } from '../control-plane/steps.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';

export type NewStepSpec = Omit<NewStep, 'runId'>;

export type AttemptResult = {
  output: unknown;
  /** The agent's explicit routing verdict (REVO_RESULT top-level `verdict`), if it emitted one. The
   *  data-driven engine routes a `choice`/gate on this DOMAIN label (0016 follow-up — a prominent
   *  required field is far more reliable than mining a prose `output`). */
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
