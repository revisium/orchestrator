/**
 * RunnerModule — provides RUN_AGENT and IntegratorService.
 *
 * Default PROCESS_EXECUTOR = spawnExecutor (real). Tests override with a fake.
 * DBOS-SEALED: zero @dbos-inc imports.
 */
import { Module } from '@nestjs/common';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { ClaudeCodeService } from './claude-code.service.js';
import { CodexService } from './codex.service.js';
import { IntegratorService } from './integrator.js';
import { WorktreeService } from './worktree.service.js';
import { PROCESS_EXECUTOR, RUN_AGENT } from './tokens.js';
import { spawnExecutor } from '../worker/process-executor.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import { createRunAgent } from '../worker/runner-dispatch.js';

@Module({
  imports: [RevisiumModule],
  providers: [
    ClaudeCodeService,
    CodexService,
    IntegratorService,
    WorktreeService,
    { provide: PROCESS_EXECUTOR, useValue: spawnExecutor },
    {
      provide: RUN_AGENT,
      useFactory: (cc: ClaudeCodeService, codex: CodexService) =>
        createRunAgent({ claudeCode: cc.run, codex: codex.run, script: stubRunAgent }),
      inject: [ClaudeCodeService, CodexService],
    },
  ],
  exports: [RUN_AGENT, IntegratorService, WorktreeService],
})
export class RunnerModule {}
