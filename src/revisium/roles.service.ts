import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport } from '../control-plane/transport.js';
import { loadRole, loadPipelinePolicy, type Role, type PipelinePolicy } from '../control-plane/definitions.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';

export type RoleSummary = {
  id: string;
  name: string;
  surface: string;
  rights: string;
  playbookId: string;
  playbookRoleId: string;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

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
        surface: str(data.surface),
        rights: str(data.rights),
        playbookId: str(data.playbook_id),
        playbookRoleId: str(data.playbook_role_id),
      }];
    });
  }

  loadPipelinePolicy(): Promise<PipelinePolicy> {
    return loadPipelinePolicy(this.head);
  }
}
