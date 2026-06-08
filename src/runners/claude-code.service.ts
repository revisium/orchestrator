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
import { createClaudeCodeRunner } from '../worker/claude-code-runner.js';
import type { RunAgent } from '../worker/runner.js';
import type { ProcessExecutor } from '../worker/process-executor.js';
import { RunService } from '../revisium/run.service.js';
import { PROCESS_EXECUTOR } from './tokens.js';

const DEFAULT_TIMEOUT_MS = 600_000;

@Injectable()
export class ClaudeCodeService {
  private readonly runner: RunAgent;

  constructor(
    @Inject(PROCESS_EXECUTOR) executor: ProcessExecutor,
    private readonly runService: RunService,
  ) {
    this.runner = createClaudeCodeRunner({
      executor,
      resolveCwd: this.runService.makeResolveCwd(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  /** Arrow property — safe to pass unbound as a RunAgent. */
  run: RunAgent = (args) => this.runner(args);
}
