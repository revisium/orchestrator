import type { RunAgent, AttemptResult, NewStepSpec } from './runner.js';

// Zero-cost stub runner for integration testing and smoke verification.
// Teaches the full architect→developer→reviewer→integrator chain so the pipeline
// workflow can complete end-to-end with zero cost.
//
// The stub emits `output.verdict:'PASS'` for the reviewer role so the happy path
// completes straight through to integrator (T3 loop tests inject their own fakes).
//
// NOTE: developTask does NOT consume nextSteps for sequencing (the chain is in code
// per ADR-0001 §5); they are kept here for parity with the real runner-contract shape.
export const stubRunAgent: RunAgent = async ({ role, step, context }) => {
  const output: Record<string, unknown> = {
    echo: `[stub] role=${role.name} step=${step.id} contextSize=${context.length}`,
  };

  const nextSteps: NewStepSpec[] = [];

  if (role.name === 'architect') {
    output.phase = 'plan';
    nextSteps.push({
      taskId: step.taskId,
      role: 'developer',
      kind: 'implement',
      input: { from: step.id },
      modelProfile: step.modelProfile,
    });
  } else if (role.name === 'developer') {
    output.phase = 'implement';
    nextSteps.push({
      taskId: step.taskId,
      role: 'reviewer',
      kind: 'review',
      input: { from: step.id },
      modelProfile: step.modelProfile,
    });
  } else if (role.name === 'reviewer') {
    output.phase = 'review';
    output.verdict = 'PASS';
    nextSteps.push({
      taskId: step.taskId,
      role: 'integrator',
      kind: 'integrate',
      input: { from: step.id },
      modelProfile: step.modelProfile,
    });
  } else if (role.name === 'integrator') {
    output.phase = 'integrate';
    // no next steps — end of chain
  }
  // other roles: no output phase, no next steps

  const result: AttemptResult = {
    output,
    nextSteps,
    costs: [],
    needsHuman: false,
  };
  return result;
};
