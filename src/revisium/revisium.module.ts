import { Module } from '@nestjs/common';
import { EngineApiService, EngineModule as RevisiumEngineModule } from '@revisium/engine';
import { createEngineTransport } from '../control-plane/engine-transport.js';
import { RevoPrismaService } from '../storage/revo-prisma.service.js';
import { RevoStorageModule } from '../storage/revo-storage.module.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';
import { RolesService } from './roles.service.js';
import { RunService } from './run.service.js';
import { InboxService } from './inbox.service.js';
import { PlaybooksService } from './playbooks.service.js';











@Module({
  imports: [RevoStorageModule, RevisiumEngineModule.forRoot()],
  providers: [
    {
      provide: REVISIUM_TRANSPORT_HEAD,
      inject: [EngineApiService, RevoPrismaService],
      useFactory: (engine: EngineApiService, prisma: RevoPrismaService) =>
        createEngineTransport('head', engine, prisma),
    },
    RolesService,
    RunService,
    InboxService,
    PlaybooksService,
  ],
  exports: [
    REVISIUM_TRANSPORT_HEAD,
    RolesService,
    RunService,
    InboxService,
    PlaybooksService,
  ],
})
export class RevisiumModule {}
