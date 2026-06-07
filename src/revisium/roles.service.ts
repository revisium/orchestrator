import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport } from '../control-plane/data-access.js';
import { loadRole, loadModelProfile, type Role, type ModelProfile } from '../control-plane/definitions.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';

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

  loadModelProfile(level: string): Promise<ModelProfile> {
    return loadModelProfile(level, this.head);
  }
}
