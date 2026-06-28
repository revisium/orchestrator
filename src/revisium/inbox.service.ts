import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport, ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { createControlPlaneDataAccessForTransport } from '../control-plane/data-access.js';
import {
  pushInbox,
  listInbox,
  getInbox,
  resolveInbox,
  type NewInboxItem,
  type InboxFilter,
  type InboxItem,
  type ResolveInboxResult,
} from '../control-plane/inbox.js';
import { REVISIUM_TRANSPORT_DRAFT } from './tokens.js';









@Injectable()
export class InboxService {
  private readonly da: ControlPlaneDataAccess;

  constructor(
    @Inject(REVISIUM_TRANSPORT_DRAFT) private readonly draftTransport: ControlPlaneTransport,
  ) {
    this.da = createControlPlaneDataAccessForTransport(this.draftTransport);
  }





  pushInbox(item: NewInboxItem, opts?: { id?: string }): Promise<string> {
    return pushInbox(this.da, item, opts);
  }

  listInbox(filter?: InboxFilter): Promise<InboxItem[]> {
    return listInbox(this.da, filter);
  }

  getInbox(id: string): Promise<InboxItem | null> {
    return getInbox(this.da, id);
  }






  resolveInbox(itemId: string, answer: unknown, resolvedBy: string): Promise<ResolveInboxResult> {
    return resolveInbox(this.da, itemId, answer, resolvedBy);
  }
}
