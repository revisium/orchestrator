import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from '../../config.js';

// Run the crash child from SOURCE via tsx (matches how the e2e suite runs; honors the
// REVO_DATA_DIR/REVO_PORT env so the child targets the isolated test daemon).
const TSX_BIN = join(repoRoot, 'node_modules', '.bin', 'tsx');
const CHILD_ENTRY = join(repoRoot, 'src', 'e2e', 'recovery-crash-child.ts');

export type CrashStopPoint = 'plan-gate' | 'merge-gate';

/**
 * Simulate a host crash: run a stubbed feature run in a SEPARATE process up to `stopAt`, then kill
 * that process WITHOUT draining DBOS (the child calls process.exit() with no shutdown). The workflow
 * is left PENDING in the shared test Postgres; the calling test then boots a fresh host that recovers
 * it. Resolves with the crashed run's id. A separate process is mandatory — DBOS is a process-global,
 * so a real crash + recovery cannot be faked in-process.
 */
export function crashRunAt(stopAt: CrashStopPoint): Promise<{ runId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [CHILD_ENTRY, stopAt], { env: process.env, cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      const match = stdout.match(/RUNID=(\S+)/);
      if (match?.[1]) resolve({ runId: match[1] });
      else reject(new Error(`crash child did not emit RUNID (exit ${code}). stderr tail: ${stderr.slice(-400)}`));
    });
  });
}
