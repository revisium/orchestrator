export type IssueRef = {
  repo: string;
  number: number;
  url: string;
};

type IssueRefSource = 'issueRef' | 'params.issueRef' | string;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwnIssueRef(params: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(params, 'issueRef');
}

export function normalizeIssueRef(value: unknown, source: IssueRefSource = 'issueRef'): IssueRef | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record) throw new TypeError(`${source} must be an object with repo, number, and url`);

  const repo = typeof record.repo === 'string' ? record.repo.trim() : '';
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const number = record.number;

  if (!repo) throw new TypeError(`${source}.repo must be a non-empty string`);
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

export function issueRefTag(issueRef: IssueRef | undefined): string {
  return issueRef ? `#${issueRef.number}` : '';
}
