import { Module } from '@nestjs/common';
import { createClientTransport } from '../control-plane/client-transport.js';
import { REVISIUM_TRANSPORT_DRAFT, REVISIUM_TRANSPORT_HEAD } from './tokens.js';
import { RolesService } from './roles.service.js';
import { RunService } from './run.service.js';
import { InboxService } from './inbox.service.js';

/**
 * RevisiumModule — provides draft + head transport tokens, RolesService, RunService, InboxService.
 *
 * HOST-FREE: this module MUST NOT import EngineModule, HostLifecycle, or anything that
 * triggers DBOS.launch(). Its providers only need the Revisium transport. It may later be
 * imported by AppModule, but never the reverse.
 *
 * Transport factories are sync/lazy (client-transport.ts:114-119); no network at module
 * construction — RevisiumModule.compile() succeeds without a live daemon.
 *
 * Follows EngineModule (src/engine/dbos.module.ts) as the structural template.
 */
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
  ],
  exports: [
    REVISIUM_TRANSPORT_DRAFT,
    REVISIUM_TRANSPORT_HEAD,
    RolesService,
    RunService,
    InboxService,
  ],
})
export class RevisiumModule {}
