/**
 * integrator-branch-naming — deterministic feature-branch naming from a task.
 *
 * `branchName` is the contract between the worktree manager and the integrator (plan 0017): the
 * worktree is created already checked out on the SAME branch the integrator commits/pushes on, so the
 * two must derive an identical name from (taskId, title). Lifted from integrator.ts.
 */

const SLUG_MAX = 40;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((seg) => seg.length > 0)
    .join('-')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, ''); // slice() may cut mid-separator — never leave a trailing '-' (invalid-looking ref)
}

// The unique tail of a machine taskId is the segment after the LAST '_'
// (`task_<stamp>_<titleSlug>_<idSuffix>` → `<idSuffix>`). Falls back to a sanitized
// whole id when there is no usable trailing segment, so the branch stays unique + a valid ref.
function shortId(taskId: string): string {
  const tail = taskId.slice(taskId.lastIndexOf('_') + 1); // lastIndexOf -1 → whole id (no underscore)
  return slugify(tail) || slugify(taskId) || 'task';
}

/** Derive deterministic feature branch name from taskId + title. Exported so the worktree manager
 *  checks out the SAME branch the integrator commits/pushes on (plan 0017). */
export function branchName(taskId: string, title: string): string {
  const id = shortId(taskId);
  const slug = slugify(title);
  return slug ? `feat/${id}-${slug}` : `feat/${id}`; // drop empty slug so no trailing '-'
}
