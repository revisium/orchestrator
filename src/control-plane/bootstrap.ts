






import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RevisiumClient } from '@revisium/client';
import { baseUrl, getConfig, repoRoot } from '../config.js';
import { applyAdditiveSchemaMigration } from './schema-migration.js';

type BootstrapRow = { tableId: string; rowId: string; data: Record<string, unknown> };
type BootstrapConfig = { rows?: BootstrapRow[]; commitMessage?: string };



function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (e.status === 404 || e.statusCode === 404) return true;
  }
  return /\b404\b|not found|NOT_FOUND/i.test(err instanceof Error ? err.message : String(err));
}


export function bootstrapConfigPath(): string {
  return join(repoRoot, 'control-plane', 'bootstrap.config.json');
}



export async function bootstrapControlPlane(
  httpPort: number,
  client: RevisiumClient = new RevisiumClient({ baseUrl: baseUrl(httpPort) }),
): Promise<void> {
  const { org, project, branch } = getConfig();
  const configPath = bootstrapConfigPath();
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as BootstrapConfig;
  const orgScope = client.org(org);
  const projectScope = orgScope.project(project);

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

  const endpoints = await projectScope.getEndpoints();
  if (!endpoints.some((endpoint) => endpoint.type === 'REST_API')) {
    await projectScope.createEndpoint({ type: 'REST_API' });
  }

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






export async function listInstalledPlaybooks(
  httpPort: number,
  client: RevisiumClient = new RevisiumClient({ baseUrl: baseUrl(httpPort) }),
): Promise<Array<{ id: string; version?: string; catalogHash?: string }>> {
  const { org, project, branch } = getConfig();
  const head = await client.revision({ org, project, branch, revision: 'head' });
  const rows = await head.getRows('playbooks', { first: 1000 });
  return (rows.edges ?? []).flatMap((edge) => {
    if (!edge.node) return [];
    const data = edge.node.data as Record<string, unknown> | undefined;
    const version = data?.version;
    const catalogHash = data?.catalog_hash;
    return [{
      id: edge.node.id,
      version: typeof version === 'string' && version ? version : undefined,
      catalogHash: typeof catalogHash === 'string' && catalogHash ? catalogHash : undefined,
    }];
  });
}
