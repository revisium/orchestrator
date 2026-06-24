/**
 * In-process control-plane bootstrap (ADR 0006) — replaces the external `npx revisium example
 * bootstrap` with native `@revisium/client` calls so `revo start` brings up a READY stack with no
 * external tool. Idempotent (check-then-create): an existing install is a cheap no-op (a few reads,
 * no writes), a fresh one gets project + REST endpoint + tables + seed rows.
 *
 * The whole bootstrap runs on ONE `client.revision('draft')` scope (tables via applyAdditiveSchema-
 * Migration, then seed rows) and commits once. Table schemas + rows come from bootstrap.config.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RevisiumClient } from '@revisium/client';
import { baseUrl, getConfig, repoRoot } from '../config.js';
import { applyAdditiveSchemaMigration } from './schema-migration.js';

type BootstrapRow = { tableId: string; rowId: string; data: Record<string, unknown> };
type BootstrapConfig = { rows?: BootstrapRow[]; commitMessage?: string };

/**
 * True ONLY for a Revisium "not found" (404) response. Existence probes use this so a 5xx/auth/network
 * fault is NOT silently treated as "absent" (which would wrongly run a create path on a broken backend).
 */
function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (e.status === 404 || e.statusCode === 404) return true;
  }
  return /\b404\b|not found|NOT_FOUND/i.test(err instanceof Error ? err.message : String(err));
}

/** Absolute path to the committed control-plane bootstrap config (table schemas + seed rows). */
export function bootstrapConfigPath(): string {
  return join(repoRoot, 'control-plane', 'bootstrap.config.json');
}

/**
 * Ensure the control-plane project/schema/seed exist. Safe to call on every daemon boot — when
 * already bootstrapped it issues only existence checks and returns without writing.
 */
export async function bootstrapControlPlane(
  httpPort: number,
  client: RevisiumClient = new RevisiumClient({ baseUrl: baseUrl(httpPort) }),
): Promise<void> {
  const { org, project, branch } = getConfig();
  const configPath = bootstrapConfigPath();
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as BootstrapConfig;
  const orgScope = client.org(org);
  const projectScope = orgScope.project(project);

  // 1. Project (+ its initial branch) — only when absent.
  let projectExists = true;
  try {
    await projectScope.get();
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    projectExists = false;
  }
  if (!projectExists) {
    await orgScope.createProject({ projectName: project, branchName: branch });
  }

  // 2. REST_API endpoint — the orchestrator talks to Revisium over REST.
  const endpoints = await projectScope.getEndpoints();
  if (!endpoints.some((endpoint) => endpoint.type === 'REST_API')) {
    await projectScope.createEndpoint({ type: 'REST_API' });
  }

  // 3+4. ONE draft scope: tables (create-if-missing + additive drift) + seed rows, then ONE commit.
  const draft = await client.revision({ org, project, branch, revision: 'draft' });
  const migration = await applyAdditiveSchemaMigration(draft, configPath);
  let createdRows = 0;
  for (const row of config.rows ?? []) {
    let rowExists = true;
    try {
      await draft.getRow(row.tableId, row.rowId);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      rowExists = false;
    }
    if (!rowExists) {
      await draft.createRow(row.tableId, row.rowId, row.data);
      createdRows += 1;
    }
  }
  if (migration.patches > 0 || createdRows > 0) {
    await draft.commit(config.commitMessage ?? 'revo control-plane bootstrap');
  }
}

/**
 * Installed playbooks read from a FRESH client at HEAD — the presence signal for the default-playbook
 * seed when it runs before the daemon's service layer exists. A fresh client resolves the current head
 * each call, so it reflects bootstrap/earlier commits made in the same boot (unlike a cached scope).
 */
export async function listInstalledPlaybooks(
  httpPort: number,
  client: RevisiumClient = new RevisiumClient({ baseUrl: baseUrl(httpPort) }),
): Promise<Array<{ id: string; version?: string }>> {
  const { org, project, branch } = getConfig();
  const head = await client.revision({ org, project, branch, revision: 'head' });
  const rows = await head.getRows('playbooks', { first: 1000 });
  // Carry the row's recorded `version` (a data column, see import-mapper) so the version-aware seed
  // (slice 144 B1) can compare it to the bundled version — WITHOUT it, every restart reads the installed
  // version as undefined → "older" → re-seeds on every boot.
  return (rows.edges ?? []).flatMap((edge) => {
    if (!edge.node) return [];
    const version = (edge.node.data as Record<string, unknown> | undefined)?.version;
    return [{ id: edge.node.id, version: typeof version === 'string' && version ? version : undefined }];
  });
}
