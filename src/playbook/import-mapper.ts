import { createHash } from 'node:crypto';
import type { RoleCatalogRecord, PipelineCatalogRecord, PlaybookCatalogs, RunProfileCatalogRecord } from './catalog-loader.js';
import type { PlaybookManifest } from './manifest.js';
import { PlaybookError } from './errors.js';
import type { ResolvedPlaybookSource } from './source-resolver.js';
import { composeRolePrompt } from './prompt-composer.js';
import { normalizeRouteGates } from '../pipeline/route-contract.js';
import { runProfileHash } from '../control-plane/run-profiles.js';

export type VersionedRow = {
  table: 'playbooks' | 'roles' | 'pipelines' | 'run_profiles';
  rowId: string;
  data: Record<string, unknown>;
};

export type PlaybookImportRows = {
  playbookId: string;
  playbook: VersionedRow;
  roles: VersionedRow[];
  pipelines: VersionedRow[];
  runProfiles: VersionedRow[];
  catalogHash: string;
};

const ROW_ID_MAX_LENGTH = 64;
const ROW_ID_HASH_LENGTH = 12;

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

function isSafeRowIdChar(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    value === '_' ||
    value === '-'
  );
}

function trimTrailingHyphens(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '-') end -= 1;
  return value.slice(0, end);
}

function safeRowIdPart(value: string): string {
  let safe = '';
  let pendingHyphen = false;
  for (const char of value) {
    if (!isSafeRowIdChar(char) || char === '-') {
      pendingHyphen = safe.length > 0;
      continue;
    }
    if (pendingHyphen) safe += '-';
    safe += char;
    pendingHyphen = false;
  }
  return safe || 'item';
}

export function scopedImportRowId(playbookId: string, itemId: string): string {
  const safePlaybookId = safeRowIdPart(playbookId);
  const safeItemId = safeRowIdPart(itemId);
  const raw = `${safePlaybookId}-${safeItemId}`;
  const needsHash =
    raw.length > ROW_ID_MAX_LENGTH ||
    safePlaybookId !== playbookId ||
    safeItemId !== itemId;
  if (!needsHash) return raw;

  const digest = hash({ itemId, playbookId }).slice(0, ROW_ID_HASH_LENGTH);
  const prefixLength = ROW_ID_MAX_LENGTH - ROW_ID_HASH_LENGTH - 1;
  const prefix = trimTrailingHyphens(raw.slice(0, prefixLength)) || 'item';
  return `${prefix}-${digest}`;
}

export function scopedRunProfileRowId(playbookId: string, pipelineId: string, profileId: string): string {
  return scopedImportRowId(playbookId, `${pipelineId}-${profileId}`);
}

function mapRole(root: string, playbookId: string, role: RoleCatalogRecord, now: string): VersionedRow {
  if (role.runnerId === 'stub-agent') {
    throw new PlaybookError(
      'PLAYBOOK_INVALID_CATALOG',
      `Production playbook role ${role.id} must not bind runner_id stub-agent; use a run profile binding for test stubs`,
    );
  }
  const requiredPrompt = !role.runnerId.startsWith('revo-');
  const prompt = composeRolePrompt(root, role, requiredPrompt);
  const importedRoleId = scopedImportRowId(playbookId, role.id);
  return {
    table: 'roles',
    rowId: importedRoleId,
    data: {
      id: importedRoleId,
      name: role.id,
      system_prompt: prompt.prompt || `Code-backed role imported from playbook role ${role.id}.`,
      model_level: role.defaultModelLevel,
      effort: role.defaultModelLevel.endsWith('cheap') ? 'low' : 'high',
      runner: role.runnerId,
      runner_id: role.runnerId,
      allowed_tools: [...role.allowedTools],
      scope_rules: JSON.stringify({
        surface: role.surface,
        rights: role.rights,
        playbook_role_id: role.id,
        runtime_role_id: role.id,
        runner_id: role.runnerId,
      }),
      playbook_id: playbookId,
      playbook_role_id: role.id,
      source_path: role.path,
      source_hash: prompt.sourceHash,
      surface: role.surface,
      rights: role.rights,
      timeout_ms: 0,
      permission_mode: 'default',
      status: 'active',
      updated_at: now,
    },
  };
}

function mapPipeline(playbookId: string, pipeline: PipelineCatalogRecord, now: string): VersionedRow {
  const importedPipelineId = scopedImportRowId(playbookId, pipeline.id);
  return {
    table: 'pipelines',
    rowId: importedPipelineId,
    data: {
      id: importedPipelineId,
      playbook_id: playbookId,
      pipeline_id: pipeline.id,
      path: pipeline.path,
      triggers: pipeline.triggers,
      required_roles: pipeline.requiredRoles,
      alternative_roles_json: JSON.stringify(pipeline.alternativeRoles),
      optional_roles: pipeline.optionalRoles,
      route_gates: normalizeRouteGates(pipeline.routeGates),
      platform_invocation: pipeline.platformInvocation,
      execution_policy_json: JSON.stringify(pipeline.executionPolicy),
      status: 'active',
      updated_at: now,
    },
  };
}

function mapRunProfile(
  playbookId: string,
  profile: RunProfileCatalogRecord,
  now: string,
  sourcePath: string,
): VersionedRow {
  const importedProfileId = scopedRunProfileRowId(playbookId, profile.pipelineId, profile.id);
  const profileJson = {
    schemaVersion: profile.schemaVersion,
    topology: profile.topology,
    bindings: profile.bindings,
  };
  const profileHash = runProfileHash(profileJson, {
    pipelineId: profile.pipelineId,
    schemaVersion: profile.schemaVersion,
  });
  return {
    table: 'run_profiles',
    rowId: importedProfileId,
    data: {
      id: importedProfileId,
      playbook_id: playbookId,
      pipeline_id: profile.pipelineId,
      profile_id: profile.id,
      schema_version: profile.schemaVersion,
      version: profile.version,
      display_name: profile.displayName,
      summary: profile.summary,
      profile_json: JSON.stringify(profileJson),
      profile_hash: profileHash,
      status: profile.status,
      source_path: sourcePath,
      source_hash: profileHash,
      updated_at: now,
    },
  };
}

export function mapPlaybookRows(options: MapPlaybookRowsOptions): PlaybookImportRows {
  const now = options.now ?? new Date().toISOString();
  const playbookId = options.nameOverride ?? options.manifest.id;
  const version = options.versionOverride ?? options.source.version;
  const roleRows = options.catalogs.roles.map((role) => mapRole(options.root, playbookId, role, now));
  const runProfileRows = options.catalogs.runProfiles.map((profile) =>
    mapRunProfile(playbookId, profile, now, options.manifest.catalogs.runProfiles ?? ''),
  );
  const catalogHash = hash({
    manifest: options.manifest,
    roles: options.catalogs.roles,
    pipelines: options.catalogs.pipelines,
    runProfiles: options.catalogs.runProfiles,
    prompts: roleRows.map((r) => ({ role: r.data.playbook_role_id, hash: r.data.source_hash })),
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
      run_profiles_catalog_path: options.manifest.catalogs.runProfiles ?? '',
      catalog_hash: catalogHash,
      installed_at: now,
      updated_at: now,
    },
  };
  return {
    playbookId,
    playbook,
    roles: roleRows,
    pipelines: options.catalogs.pipelines.map((pipeline) => mapPipeline(playbookId, pipeline, now)),
    runProfiles: runProfileRows,
    catalogHash,
  };
}
