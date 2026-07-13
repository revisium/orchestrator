import { existsSync, readFileSync } from 'node:fs';
import { PlaybookError } from './errors.js';
import type { PlaybookManifest } from './manifest.js';
import { resolvePathInside } from './source-resolver.js';
import {
  assertValidPipelineExecutionPolicy,
  assertValidRunProfileCatalogRecord,
} from './catalog-schema-validator.js';

export type RoleCatalogRecord = {
  id: string;
  path: string;
  surface: string;
  rights: string;
  allowedTools: string[];
  wrappers: Record<string, string>;
};

export type PipelineCatalogRecord = {
  id: string;
  path: string;
  triggers: string[];
  routeGates: string[];
  platformInvocation: string;
  executionPolicy: unknown;
};

export type RunProfileCatalogRecord = {
  id: string;
  pipelineId: string;
  schemaVersion: string;
  version: string;
  displayName: string;
  summary: string;
  topology: unknown;
  bindings: unknown;
  status: 'active' | 'deprecated';
};

export type PlaybookCatalogs = {
  roles: RoleCatalogRecord[];
  pipelines: PipelineCatalogRecord[];
  runProfiles: RunProfileCatalogRecord[];
};

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} must be an object`);
}

function rejectAuthorityFields(record: Record<string, unknown>, fields: readonly string[], context: string): void {
  for (const field of fields) {
    if (!(field in record)) continue;
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.${field} is not part of the provider-neutral catalog contract`);
  }
}

function stringField(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.${key} must be a non-empty string`);
}

function stringArrayField(record: Record<string, unknown>, key: string, context: string): string[] {
  const value = record[key];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...value];
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.${key} must be a string array`);
}

function optionalRecord(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  if (value === undefined) return {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'string') {
        throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${key}.${k} must be a string`);
      }
      out[k] = v;
    }
    return out;
  }
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${key} must be an object`);
}

function assertUniqueIds(records: Array<{ id: string }>, context: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `Duplicate ${context} id: ${record.id}`);
    }
    seen.add(record.id);
  }
}

function assertRunProfilePipelineReferences(
  pipelines: PipelineCatalogRecord[],
  runProfiles: RunProfileCatalogRecord[],
): void {
  const pipelineIds = new Set(pipelines.map((pipeline) => pipeline.id));
  for (const profile of runProfiles) {
    if (pipelineIds.has(profile.pipelineId)) continue;
    throw new PlaybookError(
      'PLAYBOOK_INVALID_CATALOG',
      `run profile ${profile.id} references unknown pipeline id: ${profile.pipelineId}`,
    );
  }
}

function parseRole(value: unknown, index: number, root: string): RoleCatalogRecord {
  const context = `roles[${index}]`;
  const record = asRecord(value, context);
  rejectAuthorityFields(record, ['default_model_level', 'runner_id', 'runner', 'model_level', 'timeout_ms', 'permission_mode'], context);
  const path = stringField(record, 'path', context);
  const resolvedPath = resolvePathInside(root, path);
  if (!existsSync(resolvedPath)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.path does not exist: ${path}`);
  }
  const id = stringField(record, 'id', context);
  return {
    id,
    path,
    surface: stringField(record, 'surface', context),
    rights: stringField(record, 'rights', context),
    allowedTools: stringArrayField(record, 'allowed_tools', context),
    wrappers: optionalRecord(record, 'wrappers'),
  };
}

function parsePipeline(value: unknown, index: number, root: string): PipelineCatalogRecord {
  const context = `pipelines[${index}]`;
  const record = asRecord(value, context);
  rejectAuthorityFields(record, ['required_roles', 'optional_roles', 'alternative_roles'], context);
  const executionPolicy = record.execution_policy ?? {};
  assertValidPipelineExecutionPolicy(executionPolicy, `${context}.execution_policy`);
  const path = stringField(record, 'path', context);
  const resolvedPath = resolvePathInside(root, path);
  if (!existsSync(resolvedPath)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.path does not exist: ${path}`);
  }
  return {
    id: stringField(record, 'id', context),
    path,
    triggers: stringArrayField(record, 'triggers', context),
    routeGates: stringArrayField(record, 'route_gates', context),
    platformInvocation: stringField(record, 'platform_invocation', context),
    executionPolicy,
  };
}

function parseRunProfile(value: unknown, index: number): RunProfileCatalogRecord {
  const context = `runProfiles[${index}]`;
  const record = asRecord(value, context);
  assertValidRunProfileCatalogRecord(record, context);
  const status = stringField(record, 'status', context);
  if (status !== 'active' && status !== 'deprecated') {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.status must be active or deprecated`);
  }
  return {
    id: stringField(record, 'id', context),
    pipelineId: stringField(record, 'pipelineId', context),
    schemaVersion: stringField(record, 'schemaVersion', context),
    version: stringField(record, 'version', context),
    displayName: stringField(record, 'displayName', context),
    summary: stringField(record, 'summary', context),
    topology: record.topology ?? {},
    bindings: record.bindings ?? {},
    status,
  };
}

function readJsonArray(path: string, context: string): unknown[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(parsed)) return parsed;
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} must be a JSON array`);
}

export function loadPlaybookCatalogs(root: string, manifest: PlaybookManifest): PlaybookCatalogs {
  const rolePath = resolvePathInside(root, manifest.catalogs.roles);
  const pipelinePath = resolvePathInside(root, manifest.catalogs.pipelines);
  try {
    const roles = readJsonArray(rolePath, manifest.catalogs.roles).map((role, index) =>
      parseRole(role, index, root),
    );
    const pipelines = readJsonArray(pipelinePath, manifest.catalogs.pipelines).map((pipeline, index) =>
      parsePipeline(pipeline, index, root),
    );
    const runProfiles = manifest.catalogs.runProfiles
      ? readJsonArray(resolvePathInside(root, manifest.catalogs.runProfiles), manifest.catalogs.runProfiles)
        .map((profile, index) => parseRunProfile(profile, index))
      : [];
    assertUniqueIds(roles, 'role');
    assertUniqueIds(pipelines, 'pipeline');
    assertUniqueIds(runProfiles, 'run profile');
    assertRunProfilePipelineReferences(pipelines, runProfiles);
    return { roles, pipelines, runProfiles };
  } catch (error) {
    if (error instanceof PlaybookError) throw error;
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', 'Unable to load playbook catalogs', { error });
  }
}
