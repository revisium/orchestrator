import type { RunAgent, AttemptResult } from './runner.js';

// Zero-cost stub runner for integration testing and smoke verification.
//
// GENERIC (plan 0015 slice 4): the stub is role-AGNOSTIC. It emits a passing result
// (`output.verdict:'PASS'`) regardless of role so e2e happy paths complete end-to-end at zero cost.
// Real, scenario-specific verdicts are scripted by the e2e kit's agent; the stub no longer encodes any
// pipeline-role knowledge (no role-name branching, no `nextSteps` — the data-driven engine sequences
// nodes from the template, never from a runner-returned chain).
export const stubRunAgent: RunAgent = async ({ role, step, context }) => {
  const output: Record<string, unknown> = {
    echo: `[stub] role=${role.name} step=${step.id} contextSize=${context.length}`,
    verdict: 'PASS',
  };

  const result: AttemptResult = {
    output,
    nextSteps: [],
    costs: [],
    needsHuman: false,
  };
  return result;
};
