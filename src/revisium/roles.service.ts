import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport } from '../control-plane/data-access.js';
import { loadRole, loadModelProfile, loadPipelinePolicy, type Role, type ModelProfile, type PipelinePolicy } from '../control-plane/definitions.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';

export type RoleSummary = {
  id: string;
  name: string;
  modelLevel: string;
  runner: string;
  surface: string;
  rights: string;
  playbookId: string;
  playbookRoleId: string;
};

export type ModelProfileSummary = {
  level: string;
  provider: string;
  modelId: string;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * RolesService — thin DI wrapper over loadRole / loadModelProfile.
 * Injects the HEAD transport (versioned tables, read-only).
 * Propagates ControlPlaneError (ROW_NOT_FOUND, VALIDATION_FAILURE) unchanged.
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(REVISIUM_TRANSPORT_HEAD) private readonly head: ControlPlaneTransport,
  ) {}

  loadRole(name: string): Promise<Role> {
    return loadRole(name, this.head);
  }

  async listRoles(): Promise<RoleSummary[]> {
    const rows = await this.head.listRows('roles', { first: 500 });
    return (rows.edges ?? []).flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
      const data = node.data ?? {};
      return [{
        id: node.id,
        name: str(data.name) || node.id,
        modelLevel: str(data.model_level),
        runner: str(data.runner_id) || str(data.runner),
        surface: str(data.surface),
        rights: str(data.rights),
        playbookId: str(data.playbook_id),
        playbookRoleId: str(data.playbook_role_id),
      }];
    });
  }

  loadModelProfile(level: string): Promise<ModelProfile> {
    return loadModelProfile(level, this.head);
  }

  async listModelProfiles(): Promise<ModelProfileSummary[]> {
    const rows = await this.head.listRows('model_profiles', { first: 100 });
    return (rows.edges ?? []).flatMap((edge) => {
      const node = edge.node;
      if (!node) return [];
      const data = node.data ?? {};
      return [{
        level: str(data.level) || node.id,
        provider: str(data.provider),
        modelId: str(data.model_id),
      }];
    });
  }

  /** Load pipeline limits (max iterations/attempts, budget) from routing_policy (0008 #5). */
  loadPipelinePolicy(): Promise<PipelinePolicy> {
    return loadPipelinePolicy(this.head);
  }
}
