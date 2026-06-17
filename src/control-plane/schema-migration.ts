import { readFileSync } from 'node:fs';
import { RevisiumClient } from '@revisium/client';
import { baseUrl, getConfig } from '../config.js';

type JsonRecord = Record<string, unknown>;

type BootstrapTable = {
  id: string;
  schema: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function schemaProperties(schema: unknown): JsonRecord {
  if (!isRecord(schema)) return {};
  return isRecord(schema.properties) ? schema.properties : {};
}

function stableJson(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function computeAdditiveSchemaPatches(currentSchema: unknown, desiredSchema: unknown): JsonRecord[] {
  const currentProps = schemaProperties(currentSchema);
  const desiredProps = schemaProperties(desiredSchema);
  const patches: JsonRecord[] = [];

  for (const [name, desired] of Object.entries(desiredProps)) {
    const path = `/properties/${escapePointer(name)}`;
    if (!(name in currentProps)) {
      patches.push({ op: 'add', path, value: desired });
      continue;
    }
    if (stableJson(currentProps[name]) !== stableJson(desired)) {
      patches.push({ op: 'replace', path, value: desired });
    }
  }

  return patches;
}

function loadBootstrapTables(configPath: string): BootstrapTable[] {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { tables?: unknown };
  if (!Array.isArray(parsed.tables)) return [];
  return parsed.tables.flatMap((item): BootstrapTable[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.schema)) return [];
    return [{ id: item.id, schema: item.schema }];
  });
}

export async function applyAdditiveSchemaMigration(input: {
  configPath: string;
  httpPort: number;
  commit?: boolean;
}): Promise<{ updatedTables: string[]; patches: number }> {
  const { org, project, branch } = getConfig();
  const client = new RevisiumClient({ baseUrl: baseUrl(input.httpPort) });
  const scope = await client.branch({ org, project, branch });
  const draft = scope.draft();
  const tables = loadBootstrapTables(input.configPath);
  const updatedTables: string[] = [];
  let patchCount = 0;

  for (const table of tables) {
    let currentSchema: unknown;
    try {
      currentSchema = await draft.getTableSchema(table.id);
    } catch {
      // Table absent on an upgraded control-plane (e.g. `run_outputs`, added in 0016). The previous
      // code only PATCHED existing tables, so a brand-new table would never land on an already-
      // bootstrapped control-plane. Create it from the bootstrap schema (fresh bootstrap already
      // creates every config table; this covers the upgrade path).
      await draft.createTable(table.id, table.schema);
      updatedTables.push(table.id);
      patchCount += 1;
      continue;
    }
    const patches = computeAdditiveSchemaPatches(currentSchema, table.schema);
    if (patches.length === 0) continue;
    await draft.updateTable(table.id, patches);
    updatedTables.push(table.id);
    patchCount += patches.length;
  }

  if (input.commit !== false && patchCount > 0) {
    await draft.commit('revo bootstrap schema migration');
  }

  return { updatedTables, patches: patchCount };
}
