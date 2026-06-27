/**
 * ClaudeCodeService — Nest provider wrapping createClaudeCodeRunner.
 *
 * Injects a PROCESS_EXECUTOR DI token so tests can inject a fake ProcessExecutor
 * without spawning a real `claude` process (M2).
 *
 * resolveCwd comes from RunService.makeResolveCwd() — STEP-level (reads tasks.repo_ref).
 *
 * DBOS-SEALED: zero @dbos-inc imports.
 */
import { Injectable, Inject } from '@nestjs/common';
import { join } from 'node:path';
import { createClaudeCodeRunner } from '../worker/claude-code-runner.js';
import type { RunAgent } from '../worker/runner.js';
import { DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS, type ProcessExecutor } from '../worker/process-executor.js';
import { createArtifactStore } from '../worker/artifact-store.js';
import { RunService } from '../revisium/run.service.js';
import { PROCESS_EXECUTOR } from './tokens.js';
import { getConfig } from '../config.js';

@Injectable()
export class ClaudeCodeService {
  private readonly runner: RunAgent;

  constructor(
    @Inject(PROCESS_EXECUTOR) executor: ProcessExecutor,
    @Inject(RunService)
    private readonly runService: RunService,
  ) {
    this.runner = createClaudeCodeRunner({
      executor,
      resolveCwd: this.runService.makeResolveCwd(),
      timeoutMs: DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS,
      artifactStore: createArtifactStore(join(getConfig().dataDir, 'run-artifacts')),
    });
  }

  /** Arrow property — safe to pass unbound as a RunAgent. */
  run: RunAgent = (args) => this.runner(args);
}
