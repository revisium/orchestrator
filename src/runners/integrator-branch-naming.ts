/**
 * integrator-branch-naming — deterministic feature-branch naming from a task.
 *
 * `branchName` is the contract between the worktree manager and the integrator: the
 * worktree is created already checked out on the SAME branch the integrator commits/pushes on, so the
 * two must derive an identical name from (taskId, title). Lifted from integrator.ts.
 */
import type { IssueRef } from '../run/issue-ref.js';

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

function issueBoundSlug(title: string, issueRef: IssueRef): string {
  const issueSlug = `issue-${issueRef.number}`;
  const titleSlug = slugify(title);
  if (!titleSlug) return issueSlug;
  const titleMax = Math.max(0, SLUG_MAX - issueSlug.length - 1);
  const titlePart = titleSlug.slice(0, titleMax).replace(/-+$/, '');
  return titlePart ? `${issueSlug}-${titlePart}` : issueSlug;
}

/** Derive deterministic feature branch name from taskId + title. Exported so the worktree manager
 *  checks out the SAME branch the integrator commits/pushes on. */
export function branchName(taskId: string, title: string, issueRef?: IssueRef): string {
  const id = shortId(taskId);
  const slug = slugify(title);
  if (issueRef) {
    return `feat/${id}-${issueBoundSlug(title, issueRef)}`;
  }
  return slug ? `feat/${id}-${slug}` : `feat/${id}`; // drop empty slug so no trailing '-'
}

/** The `feat/<shortId>-` prefix shared by every branch `branchName(taskId, *)` can produce.
 *  Use this in emulators/assertions to scope gh-call lookups to a specific task without knowing
 *  the title. */
export function taskBranchPrefix(taskId: string): string {
  return `feat/${shortId(taskId)}-`;
}
