import { Module } from '@nestjs/common';
import { EngineModule } from './engine/dbos.module.js';
import { HostLifecycle } from './host/host.lifecycle.js';

/**
 * Root NestJS module for the agent-orchestrator host.
 *
 * ConfigModule / CLI module wrapping deferred to slice 0002 (OQ-4).
 * config.ts stays a plain functional import in 0001.
 */
@Module({
  imports: [EngineModule],
  providers: [HostLifecycle],
})
export class AppModule {}
