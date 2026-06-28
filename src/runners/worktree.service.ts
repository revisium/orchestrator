









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


  release = async (runId: string, taskId: string): Promise<void> => {
    let baseRepoCwd: string;
    try {
      baseRepoCwd = await this.resolveBaseCwd(taskId);
    } catch {
      return;
    }
    releaseRunWorktree({ runId, baseRepoCwd, dataDir: getConfig().dataDir });
  };
}
