// One-time e2e setup: install the agent playbook ONCE before any e2e file runs (chained via `&&`
// in the `test:e2e` script). Runs as its own process and exits, so the test files boot fresh and see
// the committed playbook — avoiding the stale-head trap where a file that installs in its own `before`
// cannot resolve the just-installed playbook (its head scope was cached before the commit).
import 'reflect-metadata';
import { ensureRevisium } from '../src/host/ensure-revisium.js';
import { createClientTransport } from '../src/control-plane/client-transport.js';
import { PlaybooksService } from '../src/revisium/playbooks.service.js';
import { PLAYBOOK_SOURCE } from '../src/e2e/kit/env.js';

const PLAYBOOK_ID = 'revisium-agent-playbook'; // matches scenarios.ts PLAYBOOK_ID

async function main(): Promise<void> {
  if (process.env['REVO_E2E_REAL'] !== '1') return; // no-op unless the real e2e is requested
  await ensureRevisium(); // daemon already up in CI (revisium start + bootstrap) / warm locally
  const playbooks = new PlaybooksService(createClientTransport('head'));
  const installed = await playbooks.listPlaybooks();
  if (installed.some((p) => p.id === PLAYBOOK_ID)) {
    console.log('[e2e setup] playbook already installed — skipping');
    return;
  }
  try {
    const r = await playbooks.install({ source: PLAYBOOK_SOURCE, name: PLAYBOOK_ID, commit: true });
    console.log(`[e2e setup] installed playbook ${r.playbookId} (${r.roles} roles, ${r.pipelines} pipelines)`);
  } catch (err) {
    if (!/not a draft|already|nothing to commit|ROW_CONFLICT/i.test(String(err))) throw err;
    console.log('[e2e setup] playbook install raced/duplicate — tolerated');
  }
}

await main();
process.exit(0);
