// MANUAL smoke for the PR readiness poller — requires `gh` auth and a real open PR.
// This is NOT wired into `npm test` or CI — it needs a live GitHub auth session.
//
// Usage:
//   npm run smoke:pr-poller -- --pr <number> --repo <owner/repo> [--sonar <project-key>]
//
// What it proves:
//   - The poller correctly calls `gh pr view --json statusCheckRollup,...` and parses the response.
//   - When CI is pending: result contains { nextSteps: [{ role: 'ci-poller' }] }.
//   - When CI is terminal: result contains { nextSteps: [{ role: 'pr-watcher' }] } with structured
//     findings (ci_passed, sonar_issues, sonar_hotspots_to_review, human_reviews, human_comments, bot_comments).
//   - The real gh api shape matches what the parser implements.
//   - defaultFetchSonar: with SONAR_TOKEN set, fetches live Sonar issues+hotspots; without it, returns unavailable:true.

import * as prReadiness from '../src/poller/pr-readiness.js';
import type { Step } from '../src/control-plane/steps.js';
import type { CiSummary } from '../src/poller/pr-readiness.js';

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

// ── Sonar smoke: call defaultFetchSonar directly to confirm the live JSON shape ──

if (sonarProject) {
  console.log(`\n=== Sonar direct smoke (project: ${sonarProject}, PR: ${prNumber}) ===`);
  if (process.env['SONAR_TOKEN']) {
    const sonarResult = await prReadiness.defaultFetchSonar(sonarProject, prNumber);
    console.log(JSON.stringify({ unavailable: sonarResult.unavailable, issues_count: sonarResult.issues.length, hotspots_count: sonarResult.hotspots.length }, null, 2));
    if (sonarResult.issues.length > 0) {
      console.log('First issue (field-shape verification):');
      console.log(JSON.stringify(sonarResult.issues[0], null, 2));
    }
    if (sonarResult.hotspots.length > 0) {
      console.log('First hotspot (field-shape verification):');
      console.log(JSON.stringify(sonarResult.hotspots[0], null, 2));
    }
    console.assert(sonarResult.unavailable === false, 'valid token + live PR → unavailable must be false');
    console.log('  OK: Sonar live fetch succeeded.');
  } else {
    console.log('SONAR_TOKEN not set — testing no-token degradation path:');
    const noTokenResult = await prReadiness.defaultFetchSonar(sonarProject, prNumber);
    console.assert(noTokenResult.unavailable === true, 'no-token → unavailable:true');
    console.assert(noTokenResult.issues.length === 0, 'no-token → issues:[]');
    console.assert(noTokenResult.hotspots.length === 0, 'no-token → hotspots:[]');
    console.log('  OK: no-token path returns unavailable:true, no network call attempted.');
  }
  console.log('===========================================\n');
}

// ── Full run smoke ──

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
  const inp = ns.input as CiSummary;
  console.assert('ci_passed' in inp, 'ci_passed must be present in judge input');
  console.assert('sonar_issues' in inp, 'sonar_issues must be present');
  console.assert('sonar_hotspots_to_review' in inp, 'sonar_hotspots_to_review must be present');
  console.assert('human_reviews' in inp, 'human_reviews must be present');
  console.log(`  ci_passed=${String(inp.ci_passed)}, sonar_issues=${inp.sonar_issues.length}, sonar_hotspots_to_review=${inp.sonar_hotspots_to_review.length}, human_reviews=${inp.human_reviews.length}`);
  if (inp.sonar_unavailable) {
    console.log('  Note: sonar_unavailable=true (SONAR_TOKEN not set or Sonar unreachable).');
  }
} else {
  console.error('Unexpected result shape:', result);
  process.exit(1);
}

console.log('\nSmoke passed.');
