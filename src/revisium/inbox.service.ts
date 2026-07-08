import { Inject, Injectable } from '@nestjs/common';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
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
import { createPrismaRuntimeDataAccess } from '../run/prisma-runtime-data-access.js';
import { RevoPrismaService } from '../storage/revo-prisma.service.js';









@Injectable()
export class InboxService {
  private readonly da: ControlPlaneDataAccess;

  constructor(@Inject(RevoPrismaService) prismaOrDataAccess: RevoPrismaService | ControlPlaneDataAccess) {
    this.da = 'assertReady' in prismaOrDataAccess
      ? prismaOrDataAccess
      : createPrismaRuntimeDataAccess(prismaOrDataAccess);
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
