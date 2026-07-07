



import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineApiService } from '@revisium/engine';
import { getConfig, repoRoot } from '../config.js';
import type { RevoPrismaService } from '../storage/revo-prisma.service.js';
import {
  applyEngineBootstrapTables,
  createEngineTransport,
  ensureControlPlaneProject,
} from './engine-transport.js';
import type { ControlPlaneTransport } from './transport.js';

type BootstrapRow = { tableId: string; rowId: string; data: Record<string, unknown> };
type BootstrapTable = { id: string; schema: Record<string, unknown> };
type BootstrapConfig = { tables?: BootstrapTable[]; rows?: BootstrapRow[]; commitMessage?: string };



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



export async function bootstrapEngineControlPlane(
  engine: EngineApiService,
  prisma: RevoPrismaService,
): Promise<void> {
  const { project, branch } = getConfig();
  const config = JSON.parse(readFileSync(bootstrapConfigPath(), 'utf8')) as BootstrapConfig;

  await ensureControlPlaneProject(prisma);
  let changes = await applyEngineBootstrapTables(engine, prisma, config.tables ?? []);
  const draft = createEngineTransport('draft', engine, prisma);

  for (const row of config.rows ?? []) {
    let exists = true;
    try {
      await draft.getRow(row.tableId, row.rowId);
    } catch (err) {
      if (!(err instanceof Error) && typeof err !== 'object') throw err;
      if (!isNotFoundError(err)) throw err;
      exists = false;
    }
    if (!exists) {
      await draft.createRow(row.tableId, row.rowId, row.data);
      changes += 1;
    }
  }

  if (changes > 0) {
    await engine.createRevision({
      projectId: project,
      branchName: branch,
      comment: config.commitMessage ?? 'revo control-plane bootstrap',
    });
    draft.invalidate?.();
  }
}

export async function listInstalledPlaybooksFromTransport(
  head: ControlPlaneTransport,
): Promise<Array<{ id: string; version?: string; catalogHash?: string }>> {
  const rows = await head.listRows('playbooks', { first: 1000 });
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
