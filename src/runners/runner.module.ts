/**
 * RunnerModule — provides RUN_AGENT and IntegratorService.
 *
 * Default PROCESS_EXECUTOR = spawnExecutor (real). Tests override with a fake.
 * DBOS-SEALED: zero @dbos-inc imports.
 */
import { Module } from '@nestjs/common';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { ClaudeCodeService } from './claude-code.service.js';
import { IntegratorService } from './integrator.js';
import { PROCESS_EXECUTOR, RUN_AGENT } from './tokens.js';
import { spawnExecutor } from '../worker/process-executor.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import { createRunAgent } from '../worker/runner-dispatch.js';

@Module({
  imports: [RevisiumModule],
  providers: [
    ClaudeCodeService,
    IntegratorService,
    { provide: PROCESS_EXECUTOR, useValue: spawnExecutor },
    {
      provide: RUN_AGENT,
      useFactory: (cc: ClaudeCodeService) =>
        createRunAgent({ claudeCode: cc.run, script: stubRunAgent }),
      inject: [ClaudeCodeService],
    },
  ],
  exports: [RUN_AGENT, IntegratorService],
})
export class RunnerModule {}
