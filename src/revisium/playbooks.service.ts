import { Inject, Injectable } from '@nestjs/common';
import type { ControlPlaneTransport } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { createVersionedMeaningAccess } from '../control-plane/versioned-meaning.js';
import { PlaybookInstaller, type PlaybookInstallOptions, type PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { normalizeRouteGates } from '../pipeline/route-contract.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';

export type PlaybookSummary = {
  id: string;
  name: string;
  packageName: string;
  version: string;
  source: string;
  schemaVersion: number;
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
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
  };
}

@Injectable()
export class PlaybooksService {
  constructor(
    @Inject(REVISIUM_TRANSPORT_HEAD) private readonly head: ControlPlaneTransport,
  ) {}

  install(options: PlaybookInstallOptions): Promise<PlaybookInstallResult> {
    const installer = new PlaybookInstaller({
      access: createVersionedMeaningAccess({ dryRun: options.dryRun }),
    });
    return installer.install(options);
  }

  async listPlaybooks(): Promise<PlaybookSummary[]> {
    const rows = await this.head.listRows('playbooks', { first: 100 });
    return (rows.edges ?? []).flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
      const data = node.data ?? {};
      return [{
        id: node.id,
        name: str(data.name),
        packageName: str(data.package_name),
        version: str(data.version),
        source: str(data.source),
        schemaVersion: num(data.schema_version),
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
    playbooks.sort((left, right) => left.id.localeCompare(right.id));
    return playbooks[0];
  }

  async listPipelines(): Promise<PipelineSummary[]> {
    const rows = await this.head.listRows('pipelines', { first: 500 });
    return (rows.edges ?? []).flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
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
    return pipelineFromRow(row);
  }

  async resolvePipeline(input: { playbookId?: string; pipelineId: string }): Promise<PipelineSummary> {
    const playbook = await this.resolvePlaybook(input.playbookId);
    const direct = await this.getPipeline(input.pipelineId);
    if (direct?.playbookId === playbook.id) return direct;

    const pipelines = await this.listPipelines();
    const match = pipelines.find(
      (pipeline) => pipeline.playbookId === playbook.id && pipeline.pipelineId === input.pipelineId,
    );
    if (!match) {
      throw new ControlPlaneError(
        'ROW_NOT_FOUND',
        `pipeline not found in playbook ${playbook.id}: ${input.pipelineId}`,
      );
    }
    return match;
  }
}
