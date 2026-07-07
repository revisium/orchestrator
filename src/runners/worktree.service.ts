









import { Inject, Injectable } from '@nestjs/common';
import { RunService } from '../revisium/run.service.js';
import { getConfig } from '../config.js';
import { branchName } from './integrator.js';
import type { IssueRef } from '../run/issue-ref.js';
import { worktreePathFor } from '../control-plane/resolve-cwd.js';
import { createRunWorktree, releaseRunWorktree, type ReleaseRunWorktreeResult } from '../worker/git-worktree-manager.js';

export type WorktreeReleaseResult =
  | { released: true; worktreePath: string }
  | {
      released: false;
      reason: Extract<ReleaseRunWorktreeResult, { released: false }>['reason'];
      worktreePath: string;
    };

function withWorktreePath(result: ReleaseRunWorktreeResult, worktreePath: string): WorktreeReleaseResult {
  return result.released
    ? { released: true, worktreePath }
    : { released: false, reason: result.reason, worktreePath };
}

@Injectable()
export class WorktreeService {
  private readonly resolveBaseCwd: (taskId: string) => Promise<string>;

  constructor(@Inject(RunService) private readonly runService: RunService) {
    this.resolveBaseCwd = this.runService.makeResolveTaskCwd();
  }


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


  release = async (runId: string, taskId: string): Promise<WorktreeReleaseResult> => {
    const dataDir = getConfig().dataDir;
    const worktreePath = worktreePathFor(dataDir, runId);
    const baseRepoCwd = await this.resolveBaseCwd(taskId);
    return withWorktreePath(
      releaseRunWorktree({ runId, baseRepoCwd, dataDir }),
      worktreePath,
    );
  };
}
