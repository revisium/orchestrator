import { Module } from '@nestjs/common';
import { RevoPrismaService } from './revo-prisma.service.js';
import { RevoRepositoryStore } from '../run-resources/revo-repository.store.js';

@Module({
  providers: [RevoPrismaService, RevoRepositoryStore],
  exports: [RevoPrismaService, RevoRepositoryStore],
})
export class RevoStorageModule {}
