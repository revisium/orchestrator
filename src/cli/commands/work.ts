import { Command } from 'commander';
import { ControlPlaneError, createControlPlaneDataAccess, loadRole, loadModelProfile, type ControlPlaneDataAccess } from '../../control-plane/index.js';
import type { Step } from '../../control-plane/steps.js';
import { makeResolveCwd as sharedMakeResolveCwd } from '../../control-plane/resolve-cwd.js';
import { stubRunAgent } from '../../worker/stub-runner.js';
import { createClaudeCodeRunner } from '../../worker/claude-code-runner.js';
import { GitWorktreeManager } from '../../worker/git-worktree-manager.js';
import { createRunAgent } from '../../worker/runner-dispatch.js';
import { createScriptRunner } from '../../worker/script-runner.js';
import { spawnExecutor } from '../../worker/process-executor.js';
import type { RunAgent } from '../../worker/runner.js';
import { runWorker } from '../../worker/loop.js';
import { resolveWorkerId } from '../../worker/worker-id.js';
import { warnLiveCost, requireLiveFlag } from '../live-guard.js';

type WorkOptions = {
  once?: boolean;
  roles?: string;
  workerId?: string;
  idleSleep?: string;
  runner?: string;
  runnerTimeoutMs?: string;
  worktrees?: boolean;
  live?: boolean;
};

function formatCause(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function printHint(error: ControlPlaneError): void {
  if (error.code === 'DAEMON_NOT_RUNNING') {
    console.error('Run: revo revisium start');
  }
  if (error.code === 'BOOTSTRAP_NOT_APPLIED') {
    console.error('Run: revo bootstrap --commit');
  }
}

/**
 * makeResolveCwd — delegates to the shared resolve-cwd module (B1 fix).
 * Kept here for backward compatibility with existing call sites in workCommand.
 * Now accepts absolute existing dirs (the external target repo case), rejects
 * non-existent/non-dir paths, and guards relative '../..' traversal.
 */
export function makeResolveCwd(da: ControlPlaneDataAccess, base = process.cwd()): (step: Step) => Promise<string> {
  return sharedMakeResolveCwd(da, base);
}

export async function workCommand(options: WorkOptions): Promise<void> {
  const roles = options.roles ? options.roles.split(',').map((r) => r.trim()).filter(Boolean) : ['architect', 'developer'];
  if (roles.length === 0) {
    console.error('Error: --roles produced an empty list; provide at least one role name');
    process.exitCode = 1;
    return;
  }
  const runnerMode = options.runner ?? 'stub';
  if (runnerMode !== 'stub' && runnerMode !== 'auto') {
    console.error(`Error: --runner must be 'stub' or 'auto', got: ${runnerMode}`);
    process.exitCode = 1;
    return;
  }
  if (options.live && runnerMode !== 'auto') {
    console.error('Error: --live requires --runner auto');
    process.exitCode = 1;
    return;
  }
  if (options.worktrees && runnerMode === 'stub') {
    console.warn('--worktrees has no effect with --runner stub');
  }
  const runnerTimeoutMs = options.runnerTimeoutMs === undefined ? 600000 : Number(options.runnerTimeoutMs);
  if (!Number.isFinite(runnerTimeoutMs) || runnerTimeoutMs <= 0) {
    console.error(`Error: --runner-timeout-ms must be a positive number, got: ${String(options.runnerTimeoutMs)}`);
    process.exitCode = 1;
    return;
  }
  const workerId = resolveWorkerId(options.workerId);
  const idleSleepMs = options.idleSleep === undefined ? 5000 : Number(options.idleSleep);
  if (!Number.isFinite(idleSleepMs) || idleSleepMs < 0) {
    console.error(`Error: --idle-sleep must be a non-negative number, got: ${String(options.idleSleep)}`);
    process.exitCode = 1;
    return;
  }
  const once = options.once ?? false;

  // Cost guard: fail fast BEFORE connecting to Revisium.
  // --runner auto requires --live. Check here so tests don't need a live Revisium daemon.
  if (runnerMode === 'auto') {
    if (!requireLiveFlag(options.live ?? false, 'auto')) return;
    // Emit cost warning immediately so the user sees it before any daemon connection.
    warnLiveCost();
  }

  const abortController = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nStopping after current step…');
    abortController.abort();
  });

  try {
    const da = createControlPlaneDataAccess();
    await da.assertReady();

    // The injected runAgent is the ONLY thing that changes between modes — runWorker/WorkerDeps and
    // the loop are untouched (invariant 2). stub stays the default (zero cost; real claude is opt-in).
    let runAgent: RunAgent;
    if (runnerMode === 'auto') {
      const { run: prReadinessRun } = await import('../../poller/pr-readiness.js');
      const scriptRunner = createScriptRunner({ scripts: { 'ci-poller': { run: prReadinessRun } } });
      runAgent = createRunAgent({
        claudeCode: createClaudeCodeRunner({
          executor: spawnExecutor,
          resolveCwd: makeResolveCwd(da),
          timeoutMs: runnerTimeoutMs,
          worktreeManager: options.worktrees ? new GitWorktreeManager() : undefined,
        }),
        script: scriptRunner,
      });
    } else {
      runAgent = stubRunAgent;
    }

    await runWorker(
      {
        da,
        loadRole: (name) => loadRole(name),
        loadModelProfile: (level) => loadModelProfile(level),
        runAgent,
      },
      {
        workerId,
        roles,
        once,
        idleSleepMs,
        signal: abortController.signal,
      },
    );
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      console.error(`Error: ${formatCause(error)}`);
      printHint(error);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

export function registerWork(program: Command): void {
  program
    .command('work')
    .description('Run the worker loop. --runner stub (default, zero-cost) or auto (real claude-code dispatch)')
    .option('--once', 'Process one step then exit; exit immediately when idle')
    .option('--roles <csv>', 'Comma-separated list of roles to claim', 'architect,developer')
    .option('--worker-id <id>', 'Override the stable worker identity')
    .option('--idle-sleep <ms>', 'Milliseconds to sleep when no step is available', '5000')
    .option('--runner <mode>', "Runner mode: 'stub' (default, zero-cost) or 'auto' (real claude-code dispatch)", 'stub')
    .option('--runner-timeout-ms <n>', 'Timeout in ms for the real (auto) runner', '600000')
    .option('--worktrees', 'Use per-step git worktrees with --runner auto (git-level isolation only; npm install and port bindings are NOT isolated)')
    .option(
      '--live',
      'Use the REAL Claude runner AND the real git/gh integrator — THIS WILL CALL claude, INCUR COST, AND PUSH/OPEN A PR (requires --runner auto)',
      false,
    )
    .action(workCommand);
}
