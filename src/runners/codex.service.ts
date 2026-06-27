/**
 * CodexService — Nest provider wrapping createCodexRunner.
 *
 * Injects PROCESS_EXECUTOR so tests can use a fake executor without spawning real `codex`.
 * resolveCwd comes from RunService.makeResolveCwd().
 *
 * DBOS-SEALED: zero @dbos-inc imports.
 */
import { Inject, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { RunService } from '../revisium/run.service.js';
import { createArtifactStore } from '../worker/artifact-store.js';
import { createCodexRunner } from '../worker/codex-runner.js';
import { DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS, type ProcessExecutor } from '../worker/process-executor.js';
import type { RunAgent } from '../worker/runner.js';
import { PROCESS_EXECUTOR } from './tokens.js';

@Injectable()
export class CodexService {
  private readonly runner: RunAgent;

  constructor(
    @Inject(PROCESS_EXECUTOR) executor: ProcessExecutor,
    @Inject(RunService)
    private readonly runService: RunService,
  ) {
    this.runner = createCodexRunner({
      executor,
      resolveCwd: this.runService.makeResolveCwd(),
      timeoutMs: DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS,
      artifactStore: createArtifactStore(join(getConfig().dataDir, 'run-artifacts')),
    });
  }

  /** Arrow property — safe to pass unbound as a RunAgent. */
  run: RunAgent = (args) => this.runner(args);
}
