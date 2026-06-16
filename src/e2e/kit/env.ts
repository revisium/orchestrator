import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real e2e gate: only run against real DBOS/Revisium when explicitly enabled. */
export const RUN_REAL_E2E = process.env['REVO_E2E_REAL'] === '1';

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
