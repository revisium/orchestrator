import { resolve } from 'node:path';

/** Real e2e gate: only run against real DBOS/Revisium when explicitly enabled. */
export const RUN_REAL_E2E = process.env['REVO_E2E_REAL'] === '1';

/** `node:test` skip option — a hint string unless REVO_E2E_REAL=1 (then `false` = run). */
export const e2eSkip: string | false = RUN_REAL_E2E
  ? false
  : 'set REVO_E2E_REAL=1 to run real DBOS/Revisium E2E tests';

/** Playbook source installed by the harness; overridable via REVO_PLAYBOOK_SOURCE. */
export const PLAYBOOK_SOURCE =
  process.env['REVO_PLAYBOOK_SOURCE'] ?? resolve(process.cwd(), '../agent-playbook');
