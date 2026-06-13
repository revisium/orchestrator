import { createHash } from 'node:crypto';
import type { RoleCatalogRecord, PipelineCatalogRecord, PlaybookCatalogs } from './catalog-loader.js';
import type { PlaybookManifest } from './manifest.js';
import { PlaybookError } from './errors.js';
import type { ResolvedPlaybookSource } from './source-resolver.js';
import { composeRolePrompt } from './prompt-composer.js';

export type VersionedRow = {
  table: 'playbooks' | 'roles' | 'pipelines';
  rowId: string;
  data: Record<string, unknown>;
};

export type PlaybookImportRows = {
  playbookId: string;
  playbook: VersionedRow;
  roles: VersionedRow[];
  pipelines: VersionedRow[];
  catalogHash: string;
};

const RUNTIME_NAME_MAP: Record<string, string> = {
  analyst: 'analyst',
  architect: 'architect',
  developer: 'developer',
  reviewer: 'reviewer',
  watcher: 'pr-watcher',
  'deploy-watcher': 'deploy-watcher',
  'qa-backend': 'qa-backend',
  'qa-frontend': 'qa-frontend',
};

const RIGHTS_MAP: Record<string, { allowedTools: string[]; runtimeRunner: 'claude-code' | 'script' }> = {
  'read-only': { allowedTools: ['Read', 'Grep', 'Glob'], runtimeRunner: 'claude-code' },
  'write-working-tree': {
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    runtimeRunner: 'claude-code',
  },
  'qa-live': { allowedTools: ['Read', 'Bash'], runtimeRunner: 'claude-code' },
  'deploy-read': { allowedTools: ['Read', 'Bash'], runtimeRunner: 'claude-code' },
  'git-gh': { allowedTools: ['Read', 'Bash'], runtimeRunner: 'script' },
  'deterministic-script': { allowedTools: ['Read', 'Bash'], runtimeRunner: 'script' },
};

export type MapPlaybookRowsOptions = {
  root: string;
  source: ResolvedPlaybookSource;
  manifest: PlaybookManifest;
  catalogs: PlaybookCatalogs;
  now?: string;
  nameOverride?: string;
  versionOverride?: string;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function runtimeRoleName(roleId: string): string {
  return RUNTIME_NAME_MAP[roleId] ?? roleId;
}

export function mapRights(rights: string): { allowedTools: string[]; runtimeRunner: 'claude-code' | 'script' } {
  const mapped = RIGHTS_MAP[rights];
  if (!mapped) {
    throw new PlaybookError('PLAYBOOK_INVALID_CATALOG', `Unsupported playbook role rights: ${rights}`);
  }
  return { allowedTools: [...mapped.allowedTools], runtimeRunner: mapped.runtimeRunner };
}

function mapRole(root: string, playbookId: string, role: RoleCatalogRecord, now: string): VersionedRow {
  const rights = mapRights(role.rights);
  const requiredPrompt = rights.runtimeRunner !== 'script';
  const prompt = composeRolePrompt(root, role, requiredPrompt);
  const runtimeName = runtimeRoleName(role.id);
  const importedRoleId = `${playbookId}/${role.id}`;
  return {
    table: 'roles',
    rowId: importedRoleId,
    data: {
      id: importedRoleId,
      name: role.id,
      system_prompt: prompt.prompt || `Code-backed role imported from playbook role ${role.id}.`,
      model_level: role.defaultModelLevel,
      effort: role.defaultModelLevel === 'cheap' ? 'low' : 'high',
      runner: rights.runtimeRunner,
      allowed_tools: rights.allowedTools,
      scope_rules: JSON.stringify({
        surface: role.surface,
        rights: role.rights,
        playbook_role_id: role.id,
        runtime_role_id: runtimeName,
      }),
      playbook_id: playbookId,
      playbook_role_id: role.id,
      source_path: role.path,
      source_hash: prompt.sourceHash,
      surface: role.surface,
      rights: role.rights,
      timeout_ms: 0,
      permission_mode: 'default',
      updated_at: now,
    },
  };
}

function mapPipeline(playbookId: string, pipeline: PipelineCatalogRecord, now: string): VersionedRow {
  return {
    table: 'pipelines',
    rowId: `${playbookId}/${pipeline.id}`,
    data: {
      id: `${playbookId}/${pipeline.id}`,
      playbook_id: playbookId,
      pipeline_id: pipeline.id,
      path: pipeline.path,
      triggers: pipeline.triggers,
      required_roles: pipeline.requiredRoles,
      alternative_roles_json: JSON.stringify(pipeline.alternativeRoles),
      optional_roles: pipeline.optionalRoles,
      route_gates: pipeline.routeGates,
      platform_invocation: pipeline.platformInvocation,
      execution_policy_json: JSON.stringify(pipeline.executionPolicy ?? {}),
      updated_at: now,
    },
  };
}

export function mapPlaybookRows(options: MapPlaybookRowsOptions): PlaybookImportRows {
  const now = options.now ?? new Date().toISOString();
  const playbookId = options.nameOverride ?? options.manifest.id;
  const version = options.versionOverride ?? options.source.version;
  const catalogHash = hash({
    manifest: options.manifest,
    roles: options.catalogs.roles,
    pipelines: options.catalogs.pipelines,
  });
  const playbook: VersionedRow = {
    table: 'playbooks',
    rowId: playbookId,
    data: {
      id: playbookId,
      name: options.manifest.name,
      package_name: options.manifest.packageName || options.source.packageName,
      source: options.source.source,
      version,
      schema_version: options.manifest.schemaVersion,
      manifest_path: 'playbook.json',
      roles_catalog_path: options.manifest.catalogs.roles,
      pipelines_catalog_path: options.manifest.catalogs.pipelines,
      catalog_hash: catalogHash,
      installed_at: now,
      updated_at: now,
    },
  };
  return {
    playbookId,
    playbook,
    roles: options.catalogs.roles.map((role) => mapRole(options.root, playbookId, role, now)),
    pipelines: options.catalogs.pipelines.map((pipeline) => mapPipeline(playbookId, pipeline, now)),
    catalogHash,
  };
}
