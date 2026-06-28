




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
    .replace(/-+$/, '');
}

function shortId(taskId: string): string {
  const tail = taskId.slice(taskId.lastIndexOf('_') + 1);
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

export function branchName(taskId: string, title: string, issueRef?: IssueRef): string {
  const id = shortId(taskId);
  const slug = slugify(title);
  if (issueRef) {
    return `feat/${id}-${issueBoundSlug(title, issueRef)}`;
  }
  return slug ? `feat/${id}-${slug}` : `feat/${id}`;
}


export function taskBranchPrefix(taskId: string): string {
  return `feat/${shortId(taskId)}-`;
}
