import { resolve, sep } from 'node:path';
import { Command } from 'commander';
import { ControlPlaneError, createControlPlaneDataAccess, loadRole, loadModelProfile, type ControlPlaneDataAccess } from '../../control-plane/index.js';
import { toStr, type Step } from '../../control-plane/steps.js';
import { stubRunAgent } from '../../worker/stub-runner.js';
import { createClaudeCodeRunner } from '../../worker/claude-code-runner.js';
import { GitWorktreeManager } from '../../worker/git-worktree-manager.js';
import { createRunAgent } from '../../worker/runner-dispatch.js';
import { spawnExecutor } from '../../worker/process-executor.js';
import type { RunAgent } from '../../worker/runner.js';
import { runWorker } from '../../worker/loop.js';
import { resolveWorkerId } from '../../worker/worker-id.js';

type WorkOptions = {
  once?: boolean;
  roles?: string;
  workerId?: string;
  idleSleep?: string;
  runner?: string;
  runnerTimeoutMs?: string;
  worktrees?: boolean;
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

// Default resolveCwd (wiring only — keeps schema knowledge out of the runner, per invariant 4).
// Reads the step's task repo_ref via the data-access layer and resolves it against the workspace base.
export function makeResolveCwd(da: ControlPlaneDataAccess, base = process.cwd()): (step: Step) => Promise<string> {
  return async (step) => {
    const task = await da.getRow('tasks', step.taskId);
    if (task === null) {
      // Never silently run claude in an unintended directory: throw a lesson-bearing error so the
      // loop's catch → failStep records it.
      throw new Error(`resolveCwd: task ${step.taskId} not found — cannot resolve a working directory`);
    }
    const repoRef = toStr(task.data.repo_ref);
    if (repoRef === '' || repoRef === '.') return base;
    const resolved = resolve(base, repoRef);
    // Guard against path traversal: an absolute repoRef or a '../..' chain can escape the workspace.
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new Error(
        `resolveCwd: repo_ref ${JSON.stringify(repoRef)} resolves outside the workspace base ${JSON.stringify(base)} — refusing to launch`,
      );
    }
    return resolved;
  };
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
    const runAgent: RunAgent =
      runnerMode === 'auto'
        ? createRunAgent({
            claudeCode: createClaudeCodeRunner({
              executor: spawnExecutor,
              resolveCwd: makeResolveCwd(da),
              timeoutMs: runnerTimeoutMs,
              worktreeManager: options.worktrees ? new GitWorktreeManager() : undefined,
            }),
          })
        : stubRunAgent;

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
    .action(workCommand);
}
