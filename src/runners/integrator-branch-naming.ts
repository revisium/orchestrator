/**
 * integrator-branch-naming — deterministic feature-branch naming from a task.
 *
 * `branchName` is the contract between the worktree manager and the integrator (plan 0017): the
 * worktree is created already checked out on the SAME branch the integrator commits/pushes on, so the
 * two must derive an identical name from (taskId, title). Lifted from integrator.ts.
 */

const SLUG_MAX = 40;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((seg) => seg.length > 0)
    .join('-')
    .slice(0, SLUG_MAX);
}

/** Derive deterministic feature branch name from taskId + title. Exported so the worktree manager
 *  checks out the SAME branch the integrator commits/pushes on (plan 0017). */
export function branchName(taskId: string, title: string): string {
  const slug = slugify(title) || slugify(taskId) || 'task';
  return `feat/${taskId}-${slug}`;
}
