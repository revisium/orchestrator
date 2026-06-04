// MANUAL smoke for the PR readiness poller — requires `gh` auth and a real open PR.
// This is NOT wired into `npm test` or CI — it needs a live GitHub auth session.
//
// Usage:
//   npm run smoke:pr-poller -- --pr <number> --repo <owner/repo>
//
// What it proves:
//   - The poller correctly calls `gh pr view --json statusCheckRollup,...` and parses the response.
//   - When CI is pending: result contains { nextSteps: [{ role: 'ci-poller' }] }.
//   - When CI is terminal: result contains { nextSteps: [{ role: 'pr-watcher' }] } with structured
//     findings (ci_passed, sonar_issues, human_reviews, human_comments, bot_comments).
//   - The real gh api shape matches what the parser implements.

import * as prReadiness from '../src/poller/pr-readiness.js';
import type { Step } from '../src/control-plane/steps.js';

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

const prNumber = Number(getArg('--pr') ?? process.env['SMOKE_PR_NUMBER'] ?? '');
const repo = getArg('--repo') ?? process.env['SMOKE_REPO'] ?? '';
const sonarProject = getArg('--sonar') ?? process.env['SMOKE_SONAR_PROJECT'];

if (!prNumber || !repo) {
  console.error('Usage: npm run smoke:pr-poller -- --pr <number> --repo <owner/repo> [--sonar <project-key>]');
  console.error('  or set SMOKE_PR_NUMBER and SMOKE_REPO env vars');
  process.exit(1);
}

const fakeStep: Step = {
  id: 'smoke-step-1',
  taskId: 'smoke-task-1',
  runId: 'smoke-run-1',
  role: 'ci-poller',
  kind: 'poll',
  status: 'claimed',
  input: null,
  output: null,
  modelProfile: 'cheap',
  runAfter: '',
  attemptCount: 0,
  maxAttempts: 3,
  priority: 0,
  leaseOwner: 'smoke-worker',
  leaseExpiresAt: '',
  deadReason: '',
};

console.log(`\nSmoking PR #${prNumber} on ${repo}...\n`);

// Wrap defaultExecGh to print the raw gh output shape for inspection
const capturingExecGh: prReadiness.ExecGhFn = (ghArgs) => {
  const result = prReadiness.defaultExecGh(ghArgs);
  if (ghArgs.includes('statusCheckRollup')) {
    console.log('=== raw statusCheckRollup response ===');
    const parsed = JSON.parse(result) as { statusCheckRollup?: unknown[] };
    console.log(JSON.stringify(parsed.statusCheckRollup?.slice(0, 3), null, 2));
    console.log('======================================\n');
  }
  return result;
};

const pollInput: prReadiness.PollInput = {
  pr_number: prNumber,
  repo,
  poll_count: 0,
  max_polls: 1,
  ...(sonarProject ? { sonar_project: sonarProject } : {}),
};

const result = await prReadiness.run(pollInput, fakeStep, capturingExecGh);

console.log('=== poller result ===');
console.log(JSON.stringify(result, null, 2));
console.log('====================\n');

// Assertions
const ns = result.nextSteps[0];
if (result.needsHuman) {
  console.log('Result: CI still pending (poll_count === max_polls → needsHuman). Check manually.');
} else if (ns?.role === 'ci-poller') {
  console.log('Result: CI PENDING — poller re-queued itself (poll_count incremented).');
  const inp = ns.input as prReadiness.PollInput;
  console.assert(inp.poll_count === 1, 'poll_count should be 1 after first re-queue');
} else if (ns?.role === 'pr-watcher') {
  console.log('Result: CI TERMINAL — judge step emitted.');
  const inp = ns.input as { ci_passed: boolean; sonar_issues: unknown[]; human_reviews: unknown[] };
  console.assert('ci_passed' in inp, 'ci_passed must be present in judge input');
  console.assert('sonar_issues' in inp, 'sonar_issues must be present');
  console.assert('human_reviews' in inp, 'human_reviews must be present');
  console.log(`  ci_passed=${String(inp.ci_passed)}, sonar_issues=${inp.sonar_issues.length}, human_reviews=${inp.human_reviews.length}`);
} else {
  console.error('Unexpected result shape:', result);
  process.exit(1);
}

console.log('\nSmoke passed.');
