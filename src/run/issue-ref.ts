export type IssueRef = {
  repo: string;
  number: number;
  url: string;
};

type IssueRefSource = 'issueRef' | 'params.issueRef' | string;

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WHITESPACE_RE = /\s/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwnIssueRef(params: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(params, 'issueRef');
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizeIssueRepo(value: unknown, source: IssueRefSource): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${source}.repo must be a GitHub owner/repo full name`);
  }
  if (value.trim() !== value || hasControlCharacter(value) || WHITESPACE_RE.test(value)) {
    throw new TypeError(`${source}.repo must not contain whitespace or control characters`);
  }

  const parts = value.split('/');
  if (parts.length !== 2) {
    throw new TypeError(`${source}.repo must be a GitHub owner/repo full name`);
  }

  const [owner, repo] = parts;
  if (!owner || !repo || !GITHUB_OWNER_RE.test(owner)) {
    throw new TypeError(`${source}.repo owner must be a valid GitHub owner slug`);
  }
  if (!GITHUB_REPO_RE.test(repo) || repo === '.' || repo === '..' || repo.toLowerCase().endsWith('.git')) {
    throw new TypeError(`${source}.repo name must be a valid GitHub repository slug`);
  }
  return value;
}

export function normalizeIssueRef(value: unknown, source: IssueRefSource = 'issueRef'): IssueRef | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) throw new TypeError(`${source} must be an object with repo, number, and url`);

  const repo = normalizeIssueRepo(record.repo, source);
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const number = record.number;

  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${source}.number must be a positive integer`);
  }
  if (!url) throw new TypeError(`${source}.url must be a non-empty string`);

  return { repo, number, url };
}

export function issueRefsEqual(left: IssueRef, right: IssueRef): boolean {
  return left.repo === right.repo && left.number === right.number && left.url === right.url;
}

export function normalizeIssueRefIntoParams(
  params: Record<string, unknown>,
  topLevelIssueRef?: unknown,
): Record<string, unknown> {
  const paramsIssueRef = hasOwnIssueRef(params)
    ? normalizeIssueRef(params.issueRef, 'params.issueRef')
    : undefined;
  const issueRef = normalizeIssueRef(topLevelIssueRef, 'issueRef');

  if (paramsIssueRef && issueRef && !issueRefsEqual(paramsIssueRef, issueRef)) {
    throw new Error('issueRef conflicts with params.issueRef');
  }

  const canonical = issueRef ?? paramsIssueRef;
  return canonical ? { ...params, issueRef: canonical } : params;
}

export function issueRefFromParams(params: unknown): IssueRef | undefined {
  const record = asRecord(params);
  if (!record || !hasOwnIssueRef(record)) return undefined;
  try {
    return normalizeIssueRef(record.issueRef, 'params.issueRef');
  } catch {
    return undefined;
  }
}

export function issueRefTag(issueRef: IssueRef | undefined, repo?: string): string {
  if (!issueRef) return '';
  return repo && issueRef.repo.toLowerCase() === repo.toLowerCase() ? `#${issueRef.number}` : `${issueRef.repo}#${issueRef.number}`;
}
