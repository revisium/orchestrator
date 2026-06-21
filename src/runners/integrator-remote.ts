/**
 * integrator-remote — GitHub remote → owner/repo derivation. Lifted from integrator.ts.
 * `parseOwnerRepo` is unit-tested directly and re-exported by integrator.ts.
 */
import type { ExecFn, IntegratorBlocked } from './integrator-types.js';

// Owner and repo: GitHub-safe chars only ([A-Za-z0-9._-]); trailing .git stripped; no trailing paths.
// Non-greedy repo segment (+?) allows the (?:\.git)? suffix to back-trim a trailing ".git".
const GITHUB_SSH_RE = /^git@github\.com:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;
const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;

export function parseOwnerRepo(remoteUrl: string): string | null {
  const ssh = GITHUB_SSH_RE.exec(remoteUrl.trim());
  if (ssh?.[1]) return ssh[1];
  const https = GITHUB_HTTPS_RE.exec(remoteUrl.trim());
  if (https?.[1]) return https[1];
  return null;
}

export function resolveOwnerRepo(
  execGit: ExecFn,
  cwd: string,
): { ownerRepo: string } | IntegratorBlocked {
  let remoteUrl: string;
  try {
    remoteUrl = execGit(['remote', 'get-url', 'origin'], cwd).trim();
  } catch {
    return {
      needsHuman: true,
      lesson:
        'target repo has no parseable github remote — cannot open a PR (config gap: add a github origin remote)',
    };
  }
  const ownerRepo = parseOwnerRepo(remoteUrl);
  if (!ownerRepo) {
    return {
      needsHuman: true,
      lesson: `target repo has no parseable github remote — cannot open a PR (remote url: ${remoteUrl})`,
    };
  }
  return { ownerRepo };
}
