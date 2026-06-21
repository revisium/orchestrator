import type { RunAgent, AttemptResult } from './runner.js';

// Zero-cost stub runner for integration testing and smoke verification.
//
// GENERIC (plan 0015 slice 4): the stub is role-AGNOSTIC. It emits a top-level passing result
// (`verdict:'approved'`) regardless of role so smoke paths complete end-to-end at zero cost.
// Real, scenario-specific verdicts are scripted by the e2e kit's agent; the stub no longer encodes any
// pipeline-role knowledge (no role-name branching, no `nextSteps` — the data-driven engine sequences
// nodes from the template, never from a runner-returned chain).
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
