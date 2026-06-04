export type WorktreeManager = {
  create(stepId: string, baseDir: string): Promise<string>;
  release(worktreePath: string): Promise<void>;
};

export const noopWorktreeManager: WorktreeManager = {
  async create(_stepId, baseDir) {
    return baseDir;
  },
  async release(_worktreePath) {},
};
