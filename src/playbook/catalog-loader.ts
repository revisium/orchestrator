import { existsSync, readFileSync } from 'node:fs';
import { PlaybookError } from './errors.js';
import type { PlaybookManifest } from './manifest.js';
import { resolvePathInside } from './source-resolver.js';

export type RoleCatalogRecord = {
  id: string;
  path: string;
  surface: string;
  rights: string;
  defaultModelLevel: 'cheap' | 'standard' | 'deep';
  runnerId: string;
  wrappers: Record<string, string>;
};

export type AlternativeRoleGroup = {
  group_id: string;
  roles: string[];
  resolution: string;
};

export type PipelineCatalogRecord = {
  id: string;
  path: string;
  triggers: string[];
  requiredRoles: string[];
  alternativeRoles: AlternativeRoleGroup[];
  optionalRoles: string[];
  routeGates: string[];
  platformInvocation: string;
  executionPolicy: unknown;
};

export type PlaybookCatalogs = {
  roles: RoleCatalogRecord[];
  pipelines: PipelineCatalogRecord[];
};

const MODEL_LEVELS = new Set(['cheap', 'standard', 'deep']);
const PRODUCTION_BLOCKED_RUNNERS = new Set(['stub-agent']);

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} must be an object`);
}

function stringField(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.${key} must be a non-empty string`);
}

function normalizedStringField(record: Record<string, unknown>, key: string, context: string): string {
  return stringField(record, key, context).trim();
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

function assertKnownRole(roleIds: Set<string>, roleId: string, context: string): void {
  if (roleIds.has(roleId)) return;
  throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context} references unknown role id: ${roleId}`);
}

function assertPipelineRoleReferences(roles: RoleCatalogRecord[], pipelines: PipelineCatalogRecord[]): void {
  const roleIds = new Set(roles.map((role) => role.id));
  for (const pipeline of pipelines) {
    for (const roleId of pipeline.requiredRoles) {
      assertKnownRole(roleIds, roleId, `pipeline ${pipeline.id}.required_roles`);
    }
    for (const roleId of pipeline.optionalRoles) {
      assertKnownRole(roleIds, roleId, `pipeline ${pipeline.id}.optional_roles`);
    }
    for (const group of pipeline.alternativeRoles) {
      for (const roleId of group.roles) {
        assertKnownRole(roleIds, roleId, `pipeline ${pipeline.id}.alternative_roles.${group.group_id}`);
      }
    }
  }
}

function parseRole(value: unknown, index: number, root: string): RoleCatalogRecord {
  const context = `roles[${index}]`;
  const record = asRecord(value, context);
  const modelLevel = stringField(record, 'default_model_level', context);
  if (!MODEL_LEVELS.has(modelLevel)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.default_model_level is invalid: ${modelLevel}`);
  }
  const path = stringField(record, 'path', context);
  const resolvedPath = resolvePathInside(root, path);
  if (!existsSync(resolvedPath)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.path does not exist: ${path}`);
  }
  const runnerId = normalizedStringField(record, 'runner_id', context);
  if (PRODUCTION_BLOCKED_RUNNERS.has(runnerId)) {
    throw new PlaybookError(
      'PLAYBOOK_INVALID_CATALOG',
      `${context}.runner_id must not be ${runnerId}; use an execution profile override for test stubs`,
    );
  }
  return {
    id: stringField(record, 'id', context),
    path,
    surface: stringField(record, 'surface', context),
    rights: stringField(record, 'rights', context),
    defaultModelLevel: modelLevel as RoleCatalogRecord['defaultModelLevel'],
    runnerId,
    wrappers: optionalRecord(record, 'wrappers'),
  };
}

function parseAlternativeRoles(value: unknown, context: string): AlternativeRoleGroup[] {
  if (!Array.isArray(value)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.alternative_roles must be an array`);
  }
  return value.map((entry, index) => {
    const record = asRecord(entry, `${context}.alternative_roles[${index}]`);
    return {
      group_id: stringField(record, 'group_id', `${context}.alternative_roles[${index}]`),
      roles: stringArrayField(record, 'roles', `${context}.alternative_roles[${index}]`),
      resolution: stringField(record, 'resolution', `${context}.alternative_roles[${index}]`),
    };
  });
}

function parsePipeline(value: unknown, index: number, root: string): PipelineCatalogRecord {
  const context = `pipelines[${index}]`;
  const record = asRecord(value, context);
  const path = stringField(record, 'path', context);
  const resolvedPath = resolvePathInside(root, path);
  if (!existsSync(resolvedPath)) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `${context}.path does not exist: ${path}`);
  }
  return {
    id: stringField(record, 'id', context),
    path,
    triggers: stringArrayField(record, 'triggers', context),
    requiredRoles: stringArrayField(record, 'required_roles', context),
    alternativeRoles: parseAlternativeRoles(record.alternative_roles, context),
    optionalRoles: stringArrayField(record, 'optional_roles', context),
    routeGates: stringArrayField(record, 'route_gates', context),
    platformInvocation: stringField(record, 'platform_invocation', context),
    executionPolicy: record.execution_policy ?? {},
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
    assertUniqueIds(roles, 'role');
    assertUniqueIds(pipelines, 'pipeline');
    assertPipelineRoleReferences(roles, pipelines);
    return { roles, pipelines };
  } catch (error) {
    if (error instanceof PlaybookError) throw error;
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', 'Unable to load playbook catalogs', { error });
  }
}
