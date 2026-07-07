import { Module } from '@nestjs/common';
import { RevoPrismaService } from './revo-prisma.service.js';

@Module({
  providers: [RevoPrismaService],
  exports: [RevoPrismaService],
})
export class RevoStorageModule {}
