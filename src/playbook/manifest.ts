import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlaybookError } from './errors.js';
import { resolvePathInside } from './source-resolver.js';

export const SUPPORTED_PLAYBOOK_SCHEMA_VERSION = 2;

export type PlaybookManifest = {
  id: string;
  name: string;
  schemaVersion: number;
  packageName: string;
  catalogs: {
    roles: string;
    pipelines: string;
  };
  supportedRuntimes: string[];
};

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new PlaybookError('PLAYBOOK_INVALID_MANIFEST', `${context} must be an object`);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new PlaybookError('PLAYBOOK_INVALID_MANIFEST', `playbook.json is missing string field: ${key}`);
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...value];
  throw new PlaybookError('PLAYBOOK_INVALID_MANIFEST', `playbook.json field ${key} must be a string array`);
}

export function parsePlaybookManifest(raw: unknown): PlaybookManifest {
  const record = asRecord(raw, 'playbook.json');
  const catalogs = asRecord(record.catalogs, 'playbook.json.catalogs');
  const schemaVersion = record.schema_version;
  if (schemaVersion !== SUPPORTED_PLAYBOOK_SCHEMA_VERSION) {
    throw new PlaybookError(
      'PLAYBOOK_UNSUPPORTED_SCHEMA',
      `Unsupported playbook schema_version: ${String(schemaVersion)}`,
      { supported: [SUPPORTED_PLAYBOOK_SCHEMA_VERSION], actual: schemaVersion },
    );
  }
  return {
    id: requireString(record, 'id'),
    name: requireString(record, 'name'),
    schemaVersion,
    packageName: requireString(record, 'package'),
    catalogs: {
      roles: requireString(catalogs, 'roles'),
      pipelines: requireString(catalogs, 'pipelines'),
    },
    supportedRuntimes: optionalStringArray(record, 'supported_runtimes'),
  };
}

export function readPlaybookManifest(root: string): PlaybookManifest {
  const manifestPath = join(root, 'playbook.json');
  try {
    const manifest = parsePlaybookManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
    resolvePathInside(root, manifest.catalogs.roles);
    resolvePathInside(root, manifest.catalogs.pipelines);
    return manifest;
  } catch (error) {
    if (error instanceof PlaybookError) throw error;
    throw new PlaybookError('PLAYBOOK_INVALID_MANIFEST', `Unable to read playbook manifest: ${manifestPath}`, {
      error,
    });
  }
}
