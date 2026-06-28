import { Module } from '@nestjs/common';
import { createClientTransport } from '../control-plane/client-transport.js';
import { REVISIUM_TRANSPORT_DRAFT, REVISIUM_TRANSPORT_HEAD } from './tokens.js';
import { RolesService } from './roles.service.js';
import { RunService } from './run.service.js';
import { InboxService } from './inbox.service.js';
import { PlaybooksService } from './playbooks.service.js';











@Module({
  providers: [
    {
      provide: REVISIUM_TRANSPORT_DRAFT,
      useFactory: () => createClientTransport('draft'),
    },
    {
      provide: REVISIUM_TRANSPORT_HEAD,
      useFactory: () => createClientTransport('head'),
    },
    RolesService,
    RunService,
    InboxService,
    PlaybooksService,
  ],
  exports: [
    REVISIUM_TRANSPORT_DRAFT,
    REVISIUM_TRANSPORT_HEAD,
    RolesService,
    RunService,
    InboxService,
    PlaybooksService,
  ],
})
export class RevisiumModule {}
