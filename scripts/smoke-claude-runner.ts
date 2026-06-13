// MANUAL real-`claude -p` smoke — the hand-verification the runner-contract requires before the
// runner is trusted. This is the ONLY place a real `claude -p` runs.
//
// It is deliberately NOT wired into `pnpm test`, `pnpm run verify`, or any smoke aggregate: it spends
// tokens and needs auth.
//
//   - Auth: requires a logged-in / API-keyed `claude` CLI on PATH (the operator's machine).
//   - Cost: one real `standard`-profile call (a single trivial round-trip). Non-zero, small.
//
// Run (only when validating, not in CI):
//   ./bin/revo.js revisium start
//   ./bin/revo.js bootstrap --commit
//   pnpm run smoke:claude-runner
//
// What it proves:
//   - `claude -p` completes NON-INTERACTIVELY (clean exit 0, within the timeout — there is no TTY in
//     -p mode, so a permission-needing tool would error/hang rather than prompt). The runner throws on
//     timeout or non-zero exit, so reaching the end means it exited cleanly in time.
//   - the transport envelope parsed and the REVO_RESULT block produced a valid AttemptResult.
//   - the agent emits the block when told ONLY by the runner's appended REVO_RESULT_CONTRACT — this
//     script does NOT hand-write the emission instruction into the context, so it exercises the SAME
//     prompt path as `revo work --runner auto`.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnExecutor, type ExecRequest, type ExecResult, type ProcessExecutor } from '../src/worker/process-executor.js';
import { createClaudeCodeRunner } from '../src/worker/claude-code-runner.js';
import type { Role, ModelProfile } from '../src/control-plane/definitions.js';
import type { Step } from '../src/control-plane/steps.js';

const workdir = mkdtempSync(join(tmpdir(), 'revo-claude-smoke-'));

const role: Role = {
  name: 'architect',
  systemPrompt: 'You are the architect agent. Reply briefly. Do not use any tools.',
  modelLevel: 'standard',
  effort: 'high',
  runner: 'claude-code',
  allowedTools: [], // text-only, no tools — matches the seed role
  scopeRules: {},
};

const profile: ModelProfile = {
  level: 'standard',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  params: {},
  costPerInput: 3,
  costPerOutput: 15,
};

const step: Step = {
  id: 'smoke-step',
  taskId: 'smoke-task',
  runId: 'smoke-run',
  role: 'architect',
  kind: 'plan_run',
  status: 'running',
  input: { title: 'Smoke: respond with a one-sentence summary.' },
  output: null,
  modelProfile: 'standard',
  runAfter: '',
  attemptCount: 1,
  maxAttempts: 3,
  priority: 0,
  leaseOwner: 'smoke-worker',
  leaseExpiresAt: '',
  deadReason: '',
};

// A trivial architect-style context. NOTE: no REVO_RESULT instruction here — the runner appends it.
const context = [
  `## Role: ${role.name}`,
  role.systemPrompt,
  '## Task: Claude runner smoke',
  'Reply with a one-sentence acknowledgement. Do not use any tools.',
  '## Current step input:',
  JSON.stringify(step.input),
].join('\n');

// Wrap the real executor to print the raw transport envelope so Step 2's parseTransportEnvelope can
// be confirmed/corrected against reality.
const loggingExecutor: ProcessExecutor = async (req: ExecRequest): Promise<ExecResult> => {
  console.log(`exec: ${req.command} ${req.args.join(' ')}`);
  console.log(`cwd: ${req.cwd}`);
  const result = await spawnExecutor(req);
  console.log('─── raw transport stdout ───');
  console.log(result.stdout);
  console.log(`─── exit code=${String(result.code)} timedOut=${result.timedOut} ───`);
  if (result.stderr) console.log(`─── stderr ───\n${result.stderr}`);
  return result;
};

const runner = createClaudeCodeRunner({
  executor: loggingExecutor,
  resolveCwd: async () => workdir,
  timeoutMs: 120_000,
});

const startedAt = Date.now();
const result = await runner({
  role,
  profile,
  context,
  attemptId: `attempt_smoke_${String(startedAt)}`,
  step,
});
const elapsedMs = Date.now() - startedAt;

if (!Array.isArray(result.nextSteps)) {
  throw new TypeError('smoke:claude-runner FAILED — result.nextSteps is not an array');
}

console.log('\nsmoke:claude-runner PASSED');
console.log(`  completed non-interactively in ${elapsedMs}ms (clean exit within the timeout)`);
console.log(`  output: ${JSON.stringify(result.output)}`);
console.log(`  artifacts: ${JSON.stringify(result.artifacts ?? null)}`);
console.log(`  nextSteps: ${result.nextSteps.length}`);
console.log(`  needsHuman: ${String(result.needsHuman ?? false)}`);
console.log(`  costs: ${JSON.stringify(result.costs)}`);
