import { Inject, Injectable, Optional } from '@nestjs/common';
import { EngineApiService } from '@revisium/engine';
import { createEngineVersionedMeaningScope } from '../control-plane/engine-transport.js';
import type { ListRowsOptions } from '../control-plane/data-access.js';
import type { RowWhereInput } from '../control-plane/query-types.js';
import type { ControlPlaneTransport, TransportRow } from '../control-plane/transport.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { runProfileHash, runProfileRevisionHash } from '../control-plane/run-profiles.js';
import type { VersionedMeaningScope } from '../control-plane/versioned-meaning.js';
import { createVersionedMeaningAccess } from '../control-plane/versioned-meaning.js';
import { scopedRunProfileRowId } from '../playbook/import-mapper.js';
import { PlaybookInstaller, type PlaybookInstallOptions, type PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { normalizeRouteGates } from '../pipeline/route-contract.js';
import { RevoPrismaService } from '../storage/revo-prisma.service.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';

const DEFAULT_PLAYBOOK_ID = 'revisium-default';
const DEFAULT_PLAYBOOK_PACKAGE = '@revisium/orchestrator-default-playbook';
const CATALOG_PAGE_SIZE = 500;

export type PlaybookSummary = {
  id: string;
  name: string;
  packageName: string;
  version: string;
  source: string;
  schemaVersion: number;
  catalogHash?: string;
};

export type PipelineSummary = {
  id: string;
  playbookId: string;
  pipelineId: string;
  path: string;
  triggers: string[];
  requiredRoles: string[];
  alternativeRoles: Array<{ group_id: string; roles: string[]; resolution: string }>;
  optionalRoles: string[];
  routeGates: string[];
  executionPolicy: unknown;
  status?: 'active' | 'removed';
};

export type RunProfileSummary = {
  id: string;
  playbookId: string;
  pipelineId: string;
  profileId: string;
  schemaVersion: string;
  version: string;
  displayName: string;
  summary: string;
  profile: Record<string, unknown>;
  profileHash: string;
  profileRevisionHash: string;
  status: 'active' | 'deprecated' | 'removed';
};

export type RunProfileListPage = {
  profiles: RunProfileSummary[];
  totalCount: number;
};

export type CreateRunProfileInput = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  displayName: string;
  summary?: string;
  profile: Record<string, unknown>;
  status?: 'active' | 'deprecated';
};

export type UpdateRunProfileInput = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  expectedProfileRevisionHash: string;
  displayName?: string;
  summary?: string;
  profile?: Record<string, unknown>;
  status?: 'active' | 'deprecated';
};

export type DeprecateRunProfileInput = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  expectedProfileRevisionHash: string;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function dataEquals(path: string, equals: string): RowWhereInput {
  return { data: { path, equals } };
}

function andWhere(...clauses: RowWhereInput[]): RowWhereInput {
  return clauses.length === 1 ? clauses[0]! : { AND: clauses };
}

function strArr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter((item) => item.length > 0);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function parseJson(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function alternativeRoles(value: unknown): PipelineSummary['alternativeRoles'] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return [{
      group_id: str(record.group_id),
      roles: strArr(record.roles),
      resolution: str(record.resolution),
    }];
  });
}




type Invalidatable = { invalidate(): void };

function canInvalidate(transport: unknown): transport is Invalidatable {
  return typeof (transport as Partial<Invalidatable>).invalidate === 'function';
}

function pipelineFromRow(row: { id: string; data?: Record<string, unknown> }): PipelineSummary {
  const data = row.data ?? {};
  return {
    id: row.id,
    playbookId: str(data.playbook_id),
    pipelineId: str(data.pipeline_id) || row.id,
    path: str(data.path),
    triggers: strArr(data.triggers),
    requiredRoles: strArr(data.required_roles),
    alternativeRoles: alternativeRoles(data.alternative_roles_json),
    optionalRoles: strArr(data.optional_roles),
    routeGates: normalizeRouteGates(data.route_gates),
    executionPolicy: parseJson(data.execution_policy_json),
    status: str(data.status) === 'removed' ? 'removed' : 'active',
  };
}

function runProfileStatus(value: unknown): RunProfileSummary['status'] {
  const status = str(value);
  if (status === 'removed') return 'removed';
  if (status === 'deprecated') return 'deprecated';
  return 'active';
}

function runProfileFromRow(row: { id: string; data?: Record<string, unknown> }): RunProfileSummary {
  const data = row.data ?? {};
  const profile = parseJson(data.profile_json);
  return {
    id: row.id,
    playbookId: str(data.playbook_id),
    pipelineId: str(data.pipeline_id),
    profileId: str(data.profile_id) || row.id,
    schemaVersion: str(data.schema_version),
    version: str(data.version),
    displayName: str(data.display_name),
    summary: str(data.summary),
    profile: profile && typeof profile === 'object' && !Array.isArray(profile)
      ? profile as Record<string, unknown>
      : {},
    profileHash: str(data.profile_hash),
    profileRevisionHash: str(data.profile_revision_hash),
    status: runProfileStatus(data.status),
  };
}

function runProfileData(input: {
  rowId: string;
  playbookId: string;
  pipelineId: string;
  profileId: string;
  schemaVersion?: string;
  version?: string;
  displayName: string;
  summary: string;
  profile: Record<string, unknown>;
  status: 'active' | 'deprecated';
  sourcePath?: string;
  sourceHash?: string;
  updatedAt: string;
}): Record<string, unknown> {
  const schemaVersion = input.schemaVersion || 'run-profile/v1';
  const version = input.version || '1';
  const profileHash = runProfileHash(input.profile, {
    pipelineId: input.pipelineId,
    schemaVersion,
  });
  const profileRevisionHash = runProfileRevisionHash(input.profile, {
    playbookId: input.playbookId,
    pipelineId: input.pipelineId,
    profileId: input.profileId,
    schemaVersion,
    version,
    displayName: input.displayName,
    summary: input.summary,
    status: input.status,
  });
  return {
    id: input.rowId,
    playbook_id: input.playbookId,
    pipeline_id: input.pipelineId,
    profile_id: input.profileId,
    schema_version: schemaVersion,
    version,
    display_name: input.displayName,
    summary: input.summary,
    profile_json: JSON.stringify(input.profile),
    profile_hash: profileHash,
    profile_revision_hash: profileRevisionHash,
    status: input.status,
    source_path: input.sourcePath || '',
    source_hash: input.sourceHash || '',
    updated_at: input.updatedAt,
  };
}

function runProfileWriteStatus(value: unknown, fallback: 'active' | 'deprecated' = 'active'): 'active' | 'deprecated' {
  if (value === undefined) return fallback;
  if (value === 'active' || value === 'deprecated') return value;
  throw new ControlPlaneError('VALIDATION_FAILURE', 'run profile status must be active or deprecated');
}

async function listAllRows(
  transport: ControlPlaneTransport,
  table: string,
  options: Omit<ListRowsOptions, 'first' | 'after'> = {},
  limit?: number,
): Promise<TransportRow[]> {
  const rows: TransportRow[] = [];
  let after: string | undefined;
  for (;;) {
    const pageSize = limit === undefined ? CATALOG_PAGE_SIZE : Math.min(CATALOG_PAGE_SIZE, Math.max(0, limit - rows.length));
    if (pageSize <= 0) break;
    const page = await transport.listRows(table, {
      ...options,
      first: pageSize,
      after,
    });
    const edges = page.edges ?? [];
    rows.push(...edges.flatMap((edge) => edge.node ? [edge.node] : []));
    if (limit !== undefined && rows.length >= limit) break;
    if (edges.length < pageSize) break;
    after = edges.at(-1)?.cursor;
    if (!after) break;
  }
  return rows;
}

async function listDraftRows(
  scope: VersionedMeaningScope,
  table: string,
  options: Omit<ListRowsOptions, 'first' | 'after'> = {},
): Promise<Array<{ id: string; data?: Record<string, unknown>; cursor?: string }>> {
  const rows: Array<{ id: string; data?: Record<string, unknown>; cursor?: string }> = [];
  let after: string | undefined;
  for (;;) {
    const page = await scope.listRows(table, {
      ...options,
      first: CATALOG_PAGE_SIZE,
      after,
    });
    rows.push(...page);
    if (page.length < CATALOG_PAGE_SIZE) break;
    after = page.at(-1)?.cursor;
    if (!after) break;
  }
  return rows;
}

@Injectable()
export class PlaybooksService {
  constructor(
    @Inject(REVISIUM_TRANSPORT_HEAD) private readonly head: ControlPlaneTransport,
    @Optional()
    @Inject(EngineApiService)
    private readonly engine?: EngineApiService,
    @Optional()
    @Inject(RevoPrismaService)
    private readonly prisma?: RevoPrismaService,
  ) {}

  async install(options: PlaybookInstallOptions): Promise<PlaybookInstallResult> {
    if (!this.engine || !this.prisma) {
      throw new ControlPlaneError('CONTROL_PLANE_NOT_AVAILABLE', 'Engine-backed control-plane is not available');
    }
    const installer = new PlaybookInstaller({
      access: createVersionedMeaningAccess({
        dryRun: options.dryRun,
        scopeFactory: async () => createEngineVersionedMeaningScope(this.engine!, this.prisma!),
      }),
    });
    const result = await installer.install(options);
    if (result.committed && canInvalidate(this.head)) this.head.invalidate();
    return result;
  }

  async listPlaybooks(): Promise<PlaybookSummary[]> {
    const rows = await listAllRows(this.head, 'playbooks');
    return rows.flatMap((node) => {
      const data = node.data ?? {};
      return [{
        id: node.id,
        name: str(data.name),
        packageName: str(data.package_name),
        version: str(data.version),
        source: str(data.source),
        schemaVersion: num(data.schema_version),
        ...(str(data.catalog_hash) ? { catalogHash: str(data.catalog_hash) } : {}),
      }];
    });
  }

  async getPlaybook(id: string): Promise<PlaybookSummary | null> {
    let row;
    try {
      row = await this.head.getRow('playbooks', id);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') return null;
      throw error;
    }
    const data = row.data ?? {};
    return {
      id: row.id,
      name: str(data.name),
      packageName: str(data.package_name),
      version: str(data.version),
      source: str(data.source),
      schemaVersion: num(data.schema_version),
      ...(str(data.catalog_hash) ? { catalogHash: str(data.catalog_hash) } : {}),
    };
  }

  async resolvePlaybook(id?: string): Promise<PlaybookSummary> {
    if (id) {
      const playbook = await this.getPlaybook(id);
      if (!playbook) throw new ControlPlaneError('ROW_NOT_FOUND', `playbook not found: ${id}`);
      return playbook;
    }
    const playbooks = await this.listPlaybooks();
    if (playbooks.length === 0) {
      throw new ControlPlaneError('ROW_NOT_FOUND', 'no installed playbook found');
    }
    const defaultPlaybook = playbooks.find(
      (playbook) => playbook.id === DEFAULT_PLAYBOOK_ID || playbook.packageName === DEFAULT_PLAYBOOK_PACKAGE,
    );
    if (defaultPlaybook) return defaultPlaybook;
    playbooks.sort((left, right) => left.id.localeCompare(right.id));
    return playbooks[0];
  }

  async listPipelines(): Promise<PipelineSummary[]> {
    const rows = await listAllRows(this.head, 'pipelines', {
      where: dataEquals('status', 'active'),
    });
    return rows.flatMap((node) => {
      const data = node.data ?? {};
      return [pipelineFromRow({ id: node.id, data })];
    });
  }

  async getPipeline(id: string): Promise<PipelineSummary | null> {
    let row;
    try {
      row = await this.head.getRow('pipelines', id);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') return null;
      throw error;
    }
    if (!row) return null;
    const pipeline = pipelineFromRow(row);
    return pipeline.status === 'removed' ? null : pipeline;
  }

  async resolvePipeline(input: { playbookId?: string; pipelineId: string }): Promise<PipelineSummary> {
    const playbook = await this.resolvePlaybook(input.playbookId);
    const rows = await this.head.listRows('pipelines', {
      first: 1,
      where: andWhere(
        dataEquals('playbook_id', playbook.id),
        dataEquals('pipeline_id', input.pipelineId),
        dataEquals('status', 'active'),
      ),
    });
    const row = rows.edges?.[0]?.node;
    if (!row) {
      throw new ControlPlaneError(
        'ROW_NOT_FOUND',
        `pipeline not found in playbook ${playbook.id}: ${input.pipelineId}`,
      );
    }
    return pipelineFromRow(row);
  }

  async listRunProfiles(input: {
    playbookId?: string;
    pipelineId?: string;
    includeDeprecated?: boolean;
    first?: number;
  } = {}): Promise<RunProfileSummary[]> {
    if (input.first !== undefined) {
      return (await this.listRunProfilesPage({ ...input, first: input.first })).profiles;
    }
    const playbook = await this.resolvePlaybook(input.playbookId);
    const base = [
      dataEquals('playbook_id', playbook.id),
      ...(input.pipelineId ? [dataEquals('pipeline_id', input.pipelineId)] : []),
    ];
    const statuses: Array<RunProfileSummary['status']> = input.includeDeprecated ? ['active', 'deprecated'] : ['active'];
    const rows = await listAllRows(this.head, 'run_profiles', {
      where: andWhere(...base, { data: { path: 'status', in: statuses } }),
      orderBy: [{ field: 'id', direction: 'asc' }],
    }, input.first);
    return rows
      .map((node) => runProfileFromRow({ id: node.id, data: node.data ?? {} }))
      .sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  async listRunProfilesPage(input: {
    playbookId?: string;
    pipelineId?: string;
    includeDeprecated?: boolean;
    first: number;
  }): Promise<RunProfileListPage> {
    const playbook = await this.resolvePlaybook(input.playbookId);
    const base = [
      dataEquals('playbook_id', playbook.id),
      ...(input.pipelineId ? [dataEquals('pipeline_id', input.pipelineId)] : []),
    ];
    const statuses: Array<RunProfileSummary['status']> = input.includeDeprecated ? ['active', 'deprecated'] : ['active'];
    const rows = await this.head.listRows('run_profiles', {
      first: input.first,
      where: andWhere(...base, { data: { path: 'status', in: statuses } }),
      orderBy: [{ field: 'id', direction: 'asc' }],
    });
    const profiles = (rows.edges ?? [])
      .flatMap((edge) => edge.node ? [runProfileFromRow({ id: edge.node.id, data: edge.node.data ?? {} })] : [])
      .sort((left, right) => left.profileId.localeCompare(right.profileId));
    return {
      profiles,
      totalCount: rows.totalCount ?? profiles.length,
    };
  }

  async resolveRunProfile(input: {
    playbookId?: string;
    pipelineId: string;
    profileId: string;
    includeDeprecated?: boolean;
  }): Promise<RunProfileSummary> {
    const playbook = await this.resolvePlaybook(input.playbookId);
    const base = [
      dataEquals('playbook_id', playbook.id),
      dataEquals('pipeline_id', input.pipelineId),
      dataEquals('profile_id', input.profileId),
    ];
    const statuses: Array<RunProfileSummary['status']> = input.includeDeprecated ? ['active', 'deprecated'] : ['active'];
    const profiles = (await Promise.all(statuses.map((status) =>
      listAllRows(this.head, 'run_profiles', {
        where: andWhere(...base, dataEquals('status', status)),
      }),
    ))).flat().map((node) => runProfileFromRow({ id: node.id, data: node.data ?? {} }));
    const match = profiles.find((profile) => profile.profileId === input.profileId);
    if (!match) {
      throw new ControlPlaneError(
        'ROW_NOT_FOUND',
        `run profile not found in pipeline ${input.pipelineId}: ${input.profileId}`,
      );
    }
    return match;
  }

  async createRunProfile(input: CreateRunProfileInput): Promise<RunProfileSummary> {
    const playbookId = input.playbookId ?? (await this.resolvePlaybook()).id;
    const scope = await this.versionedScope();
    const existing = await this.findDraftRunProfile(scope, {
      playbookId,
      pipelineId: input.pipelineId,
      profileId: input.profileId,
    });
    if (existing) {
      throw new ControlPlaneError(
        'ROW_CONFLICT',
        `run profile already exists in pipeline ${input.pipelineId}: ${input.profileId}`,
      );
    }
    const rowId = scopedRunProfileRowId(playbookId, input.pipelineId, input.profileId);
    const data = runProfileData({
      rowId,
      playbookId,
      pipelineId: input.pipelineId,
      profileId: input.profileId,
      displayName: input.displayName,
      summary: input.summary ?? '',
      profile: input.profile,
      status: runProfileWriteStatus(input.status),
      updatedAt: new Date().toISOString(),
    });
    await scope.createRow('run_profiles', rowId, data);
    await scope.commit(`Create run profile ${input.profileId}`);
    this.invalidateHead();
    return runProfileFromRow({ id: rowId, data });
  }

  async updateRunProfile(input: UpdateRunProfileInput): Promise<RunProfileSummary> {
    const playbookId = input.playbookId ?? (await this.resolvePlaybook()).id;
    const scope = await this.versionedScope();
    const existing = await this.requireDraftRunProfile(scope, {
      playbookId,
      pipelineId: input.pipelineId,
      profileId: input.profileId,
    });
    const existingData = existing.data ?? {};
    const currentHash = str(existingData.profile_revision_hash);
    if (!currentHash) {
      throw new ControlPlaneError(
        'ROW_CONFLICT',
        `run profile ${input.profileId} has no profileRevisionHash and cannot be updated`,
      );
    }
    if (currentHash !== input.expectedProfileRevisionHash) {
      throw new ControlPlaneError(
        'ROW_CONFLICT',
        `run profile ${input.profileId} changed: expected ${input.expectedProfileRevisionHash}, got ${currentHash}`,
      );
    }
    const profile = input.profile ?? runProfileFromRow(existing).profile;
    const data = runProfileData({
      rowId: existing.id,
      playbookId,
      pipelineId: input.pipelineId,
      profileId: input.profileId,
      schemaVersion: str(existingData.schema_version) || 'run-profile/v1',
      version: str(existingData.version) || '1',
      displayName: input.displayName ?? str(existingData.display_name),
      summary: input.summary ?? str(existingData.summary),
      profile,
      status: runProfileWriteStatus(input.status, runProfileStatus(existingData.status) === 'deprecated' ? 'deprecated' : 'active'),
      sourcePath: str(existingData.source_path),
      sourceHash: '',
      updatedAt: new Date().toISOString(),
    });
    await scope.updateRow('run_profiles', existing.id, data);
    await scope.commit(`Update run profile ${input.profileId}`);
    this.invalidateHead();
    return runProfileFromRow({ id: existing.id, data });
  }

  async deprecateRunProfile(input: DeprecateRunProfileInput): Promise<RunProfileSummary> {
    return this.updateRunProfile({
      playbookId: input.playbookId,
      pipelineId: input.pipelineId,
      profileId: input.profileId,
      expectedProfileRevisionHash: input.expectedProfileRevisionHash,
      status: 'deprecated',
    });
  }

  private async findDraftRunProfile(
    scope: VersionedMeaningScope,
    input: { playbookId: string; pipelineId: string; profileId: string },
  ): Promise<{ id: string; data?: Record<string, unknown> } | null> {
    const rows = await listDraftRows(scope, 'run_profiles', {
      where: andWhere(
        dataEquals('playbook_id', input.playbookId),
        dataEquals('pipeline_id', input.pipelineId),
        dataEquals('profile_id', input.profileId),
      ),
    });
    return rows.find((row) => runProfileStatus(row.data?.status) !== 'removed') ?? null;
  }

  private async requireDraftRunProfile(
    scope: VersionedMeaningScope,
    input: { playbookId: string; pipelineId: string; profileId: string },
  ): Promise<{ id: string; data?: Record<string, unknown> }> {
    const row = await this.findDraftRunProfile(scope, input);
    if (!row) {
      throw new ControlPlaneError(
        'ROW_NOT_FOUND',
        `run profile not found in pipeline ${input.pipelineId}: ${input.profileId}`,
      );
    }
    return row;
  }

  private async versionedScope(): Promise<VersionedMeaningScope> {
    if (!this.engine || !this.prisma) {
      throw new ControlPlaneError('CONTROL_PLANE_NOT_AVAILABLE', 'Engine-backed control-plane is not available');
    }
    return createEngineVersionedMeaningScope(this.engine, this.prisma);
  }

  private invalidateHead(): void {
    if (canInvalidate(this.head)) this.head.invalidate();
  }
}
