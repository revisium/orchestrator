import { spawn, type ChildProcess } from 'node:child_process';

// Generic process-spawn boundary. Knows NOTHING about Claude Code — it is the testability seam:
// the runner depends on this type, and unit tests pass a fake that returns canned stdout/exit codes,
// so no real process is spawned and no tokens are spent.

export type ExecRequest = {
  command: string; // e.g. 'claude'
  args: string[]; // e.g. ['-p', '--model', 'claude-sonnet-4-6', '--output-format', 'json', ...]
  cwd: string; // resolved target repo directory
  timeoutMs: number; // kill after this
  input?: string; // prompt piped on stdin (avoids argv length limits for large context)
  env?: Record<string, string>;
};

export type ExecResult = {
  code: number | null; // process exit code; null if killed by a signal
  stdout: string;
  stderr: string;
  timedOut: boolean; // true if killed by the timeout
};

export type ProcessExecutor = (req: ExecRequest) => Promise<ExecResult>;

// Kill the whole process GROUP, not just the leader: `claude` spawns subprocesses, and only a
// negative-PID signal reaches them. `detached: true` (below) made the child its own group leader,
// so process.kill(-pid) targets the group. Fall back to a direct kill if the group send throws.
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Real implementation, used only in production wiring (never in unit tests).
export const spawnExecutor: ProcessExecutor = (req) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env ?? process.env,
      // Own process group → a negative-PID SIGKILL reaps `claude` AND its children on timeout.
      // Do NOT unref(): the parent must stay attached to collect stdout/stderr and observe exit.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, req.timeoutMs);

    // Spawn-level errors (binary missing) reject — the runner converts that to a lesson.
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // Never reject for a non-zero exit; return the result and let the runner decide how to map it.
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    // Swallow EPIPE: the child may exit before draining stdin; the 'close' handler reports the result.
    child.stdin?.on('error', () => { /* ignore broken-pipe on stdin */ });
    if (req.input !== undefined) child.stdin?.write(req.input);
    child.stdin?.end();
  });
