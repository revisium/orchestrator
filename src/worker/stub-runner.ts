import type { RunAgent, AttemptResult } from './runner.js';

export const stubRunAgent: RunAgent = async ({ role, step, context }) => {
  const output: Record<string, unknown> = {
    echo: `[stub] role=${role.name} step=${step.id} contextSize=${context.length}`,
  };

  const result: AttemptResult = {
    output,
    verdict: 'approved',
    nextSteps: [],
    costs: [],
    needsHuman: false,
  };
  return result;
};
