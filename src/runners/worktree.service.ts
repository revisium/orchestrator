/**
 * worktree.service.ts — @Injectable wrapper over the per-run git worktree manager (plan 0017).
 *
 * DBOS-SEALED: zero @dbos-inc imports. PipelineService registers `ensure`/`release` as memoized DBOS
 * steps and wires them into the data-driven adapter's run lifecycle (create after live preflight,
 * release at terminal via the workflow `finally`).
 *
 * Resolves the BASE target-repo checkout (where `git worktree add/remove` run) and the feature branch
 * (the SAME `branchName` the integrator commits/pushes on) so the worktree is created already on that
 * branch — making the integrator's branchExists→switch path a no-op and avoiding its dirty-tree
 * `switch -c origin/<base>` failure.
 */
import { Inject, Injectable } from '@nestjs/common';
import { RunService } from '../revisium/run.service.js';
import { getConfig } from '../config.js';
import { branchName } from './integrator.js';
import type { IssueRef } from '../run/issue-ref.js';
import { createRunWorktree, releaseRunWorktree } from '../worker/git-worktree-manager.js';

@Injectable()
export class WorktreeService {
  private readonly resolveBaseCwd: (taskId: string) => Promise<string>;

  constructor(@Inject(RunService) private readonly runService: RunService) {
    this.resolveBaseCwd = this.runService.makeResolveTaskCwd();
  }

  /** Create-if-absent the run's isolated worktree. Arrow property: safe to pass unbound to registerStep. */
  ensure = async (
    runId: string,
    taskId: string,
    title: string,
    base: string,
    issueRef?: IssueRef,
  ): Promise<{ worktreePath: string }> => {
    const baseRepoCwd = await this.resolveBaseCwd(taskId);
    const branch = branchName(taskId, title, issueRef);
    return createRunWorktree({ runId, baseRepoCwd, base, branch, dataDir: getConfig().dataDir });
  };

  /** Release the run's worktree (best-effort, idempotent). Arrow property for safe unbound registration. */
  release = async (runId: string, taskId: string): Promise<void> => {
    let baseRepoCwd: string;
    try {
      baseRepoCwd = await this.resolveBaseCwd(taskId);
    } catch {
      // Task/repo no longer resolvable — nothing to remove from; the worktree dir (if any) is orphaned
      // and will be swept by `git worktree prune` on a later run against the same base repo.
      return;
    }
    releaseRunWorktree({ runId, baseRepoCwd, dataDir: getConfig().dataDir });
  };
}
