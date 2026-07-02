import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real e2e gate: only run against real DBOS/Revisium when explicitly enabled. */
export const RUN_REAL_E2E = process.env['REVO_E2E_REAL'] === '1';

/** Per-file DBOS system database name (a valid SQL identifier for REVO_DBOS_DB). */
export function dbosDbNameForFile(filePath: string): string {
  const base = basename(filePath)
    .replace(/\.e2e\.test\.ts$/, '')
    .replace(/\.(m|c)?ts$/, '')
    .replace(/[^a-zA-Z0-9]/g, '_');
  return `dbos_e2e_${base}`;
}

// Each e2e file runs in its own process against the shared embedded Postgres. Giving every file its
// own DBOS system db (host boot CREATEs it on demand) isolates queues and workflows between files —
// no cross-file recovery, no shared dev-tasks slots — which is what makes the files safe to run in
// parallel. Set only when absent: crash-recovery child processes inherit the parent file's env and
// MUST target the parent's db (the parent's next boot proves recovery of the child's workflows).
if (RUN_REAL_E2E && !process.env['REVO_DBOS_DB'] && process.argv[1]) {
  process.env['REVO_DBOS_DB'] = dbosDbNameForFile(process.argv[1]);
}

/** `node:test` skip option — a hint string unless REVO_E2E_REAL=1 (then `false` = run). */
export const e2eSkip: string | false = RUN_REAL_E2E
  ? false
  : 'set REVO_E2E_REAL=1 to run real DBOS/Revisium E2E tests';

/**
 * Playbook installed by the harness. Defaults to the SELF-CONTAINED fixture committed under
 * `src/e2e/fixtures/playbook` (roles + pipelines catalog), so e2e runs are stable and independent
 * of the external agent-playbook checkout. Module-relative (not cwd-dependent). Overridable via
 * REVO_PLAYBOOK_SOURCE to install a different playbook.
 */
export const PLAYBOOK_SOURCE =
  process.env['REVO_PLAYBOOK_SOURCE'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/playbook');
