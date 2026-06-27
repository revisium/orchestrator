import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

export type PrReadinessVerdict =
  | 'ready'
  | 'waiting'
  | 'needs_work'
  | 'needs_human'
  | 'merged'
  | 'closed'
  | 'unknown';

export type PrReadinessNextAction =
  | 'watcher_wait'
  | 'developer_fix'
  | 'reviewer_triage'
  | 'human_decision'
  | 'ready_for_merge_gate'
  | 'none';

export type PrReadinessInput = {
  repo: string;
  prNumber?: number;
  headBranch?: string;
  baseBranch?: string;
  sonarProject?: string;
  includeComments?: boolean;
  includeReviewThreads?: boolean;
};

export type PollInput = {
  pr_number?: number;
  repo: string;
  head_branch?: string;
  base_branch?: string;
  sonar_project?: string;
  poll_count: number;
  poll_interval_ms?: number;
  max_polls?: number;
};

export type CheckRunNode = {
  __typename: 'CheckRun';
  name: string;
  status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED';
  conclusion: string | null;
};

export type StatusContextNode = {
  __typename: 'StatusContext';
  context: string;
  state: 'PENDING' | 'SUCCESS' | 'FAILURE' | 'ERROR';
};

export type UnknownCheckNode = {
  __typename: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

export type ReviewEntry = {
  user: { login: string; type?: string } | null;
  state: string;
  body: string;
};

export type CommentEntry = {
  user: { login: string; type?: string } | null;
  path?: string;
  line?: number;
  body: string;
};

export type SonarIssue = {
  severity: string;
  message: string;
  component: string;
  rule?: string;
  line?: number;
};

export type SonarHotspot = {
  message: string;
  component: string;
  line?: number;
  securityCategory?: string;
  vulnerabilityProbability?: string;
};

export type CiSummary = {
  ci_passed: boolean;
  checks: Array<{ name: string; result: string }>;
  isDraft?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  mergeable?: string;
  sonar_issues: SonarIssue[];
  sonar_hotspots_to_review: SonarHotspot[];
  sonar_unavailable?: boolean;
  human_reviews: ReviewEntry[];
  human_comments: CommentEntry[];
  bot_comments: CommentEntry[];
};

type PrViewData = {
  number?: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  statusCheckRollup: UnknownCheckNode[] | null;
  mergeStateStatus?: string;
  reviewDecision?: string;
  mergeable?: string;
};

export type ExecGhFn = (args: string[]) => string;

const GH_EXECUTABLE_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const;

function resolveGhExecutable(): string {
  for (const candidate of GH_EXECUTABLE_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed system location.
    }
  }
  throw new Error(`gh executable not found in fixed locations: ${GH_EXECUTABLE_CANDIDATES.join(', ')}`);
}

export function defaultExecGh(args: string[]): string {
  return execFileSync(resolveGhExecutable(), args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

export type SonarResult = {
  issues: SonarIssue[];
  hotspots: SonarHotspot[];
  unavailable: boolean;
};

export type FetchSonarFn = (projectKey: string, prNumber: number) => Promise<SonarResult>;

function pickLine(top: unknown, tRange: Record<string, unknown> | undefined): number | undefined {
  if (typeof top === 'number') return top;
  const s = tRange?.['startLine'];
  return typeof s === 'number' ? s : undefined;
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function mapSonarIssue(i: Record<string, unknown>): SonarIssue {
  const tRange = i['textRange'] as Record<string, unknown> | undefined;
  const rule = asStr(i['rule']);
  return {
    severity: asStr(i['severity'], 'UNKNOWN'),
    message: asStr(i['message']),
    component: asStr(i['component']),
    rule: rule || undefined,
    line: pickLine(i['line'], tRange),
  };
}

function mapSonarHotspot(h: Record<string, unknown>): SonarHotspot {
  const tRange = h['textRange'] as Record<string, unknown> | undefined;
  const securityCategory = asStr(h['securityCategory']);
  const vulnerabilityProbability = asStr(h['vulnerabilityProbability']);
  return {
    message: asStr(h['message']),
    component: asStr(h['component']),
    line: pickLine(h['line'], tRange),
    securityCategory: securityCategory || undefined,
    vulnerabilityProbability: vulnerabilityProbability || undefined,
  };
}

export async function defaultFetchSonar(projectKey: string, prNumber: number): Promise<SonarResult> {
  const token = process.env['SONAR_TOKEN'];
  if (!token) return { issues: [], hotspots: [], unavailable: true };
  const host = process.env['SONAR_HOST_URL'] ?? 'https://sonarcloud.io';
  const auth = 'Basic ' + Buffer.from(`${token}:`).toString('base64');

  try {
    const issuesUrl =
      `${host}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}` +
      `&pullRequest=${prNumber}&statuses=OPEN,CONFIRMED,REOPENED&ps=500`;
    const hotspotsUrl =
      `${host}/api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}` +
      `&pullRequest=${prNumber}&status=TO_REVIEW&ps=500`;

    const [issuesRes, hotspotsRes] = await Promise.all([
      fetch(issuesUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) }),
      fetch(hotspotsUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!issuesRes.ok || !hotspotsRes.ok) {
      const failed = issuesRes.ok ? `hotspots ${hotspotsRes.status}` : `issues ${issuesRes.status}`;
      console.warn(`[sonar] fetch degraded: ${failed}`);
      return { issues: [], hotspots: [], unavailable: true };
    }

    const issuesJson = (await issuesRes.json()) as { issues?: Array<Record<string, unknown>> };
    const hotspotsJson = (await hotspotsRes.json()) as { hotspots?: Array<Record<string, unknown>> };

    return {
      issues: (issuesJson.issues ?? []).map(mapSonarIssue),
      hotspots: (hotspotsJson.hotspots ?? []).map(mapSonarHotspot),
      unavailable: false,
    };
  } catch (err) {
    console.warn(`[sonar] fetch degraded: ${String(err)}`);
    return { issues: [], hotspots: [], unavailable: true };
  }
}

export function toFinitePositive(value: unknown, defaultValue: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function parseGhJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`gh returned non-JSON for ${label}: ${raw.slice(0, 200)}`);
  }
}

type PrListEntry = { number: number; baseRefName: string; state: string };

type OpenPrResult =
  | { kind: 'open'; prNumber: number; prView: PrViewData }
  | { kind: 'merged'; prNumber: number; prView?: PrViewData }
  | { kind: 'needsHuman'; verdict: string; lesson: string; prNumber?: number; prView?: PrViewData };

const NOT_FOUND_RE = /could not resolve|could not find|no pull requests? found|not found/i;

function resolvePrByBranch(
  repo: string,
  headBranch: string,
  baseBranch: string,
  execGh: ExecGhFn,
): { pr_number: number } | { needsHuman: true; lesson: string } {
  const raw = execGh([
    'pr', 'list', '--repo', repo, '--head', headBranch, '--state', 'open',
    '--json', 'number,baseRefName,state',
  ]);
  const prs = parseGhJson<PrListEntry[]>(raw, `pr list --head ${headBranch}`);
  const onBase = prs.filter((p) => p.baseRefName === baseBranch);

  if (onBase.length === 0) {
    return { needsHuman: true, lesson: `No open PR for head branch "${headBranch}" with base "${baseBranch}" in ${repo} - manual review needed` };
  }
  if (onBase.length === 1) return { pr_number: onBase[0].number };

  const candidates = onBase.map((p) => p.number).join(', ');
  return {
    needsHuman: true,
    lesson: `Ambiguous: ${onBase.length} open PRs for head branch "${headBranch}" targeting base "${baseBranch}" - candidates #${candidates} - manual review needed`,
  };
}

function fetchPrView(prNumber: number, repo: string, execGh: ExecGhFn): PrViewData {
  const raw = execGh([
    'pr', 'view', String(prNumber), '--repo', repo,
    '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable',
  ]);
  return parseGhJson<PrViewData>(raw, `pr view #${prNumber}`);
}

function handleClosedPr(
  prNumber: number,
  resolvedFromBranch: boolean,
  input: PrReadinessInput,
  baseBranch: string,
  execGh: ExecGhFn,
  prView?: PrViewData,
): OpenPrResult {
  if (!input.headBranch || resolvedFromBranch) {
    return { kind: 'needsHuman', verdict: 'closed', lesson: `PR #${prNumber} was closed without merging - manual review needed`, prNumber, prView };
  }
  const r = resolvePrByBranch(input.repo, input.headBranch, baseBranch, execGh);
  if ('needsHuman' in r) {
    return { kind: 'needsHuman', verdict: 'closed', lesson: `PR #${prNumber} was closed; ${r.lesson}`, prNumber, prView };
  }
  const newPrView = fetchPrView(r.pr_number, input.repo, execGh);
  if (newPrView.state === 'MERGED') return { kind: 'merged', prNumber: r.pr_number, prView: newPrView };
  if (newPrView.state === 'CLOSED') {
    return { kind: 'needsHuman', verdict: 'closed', lesson: `PR #${r.pr_number} (recovered via "${input.headBranch}") is also closed - manual review needed`, prNumber: r.pr_number, prView: newPrView };
  }
  return { kind: 'open', prNumber: r.pr_number, prView: newPrView };
}

function resolveOpenPr(input: PrReadinessInput, baseBranch: string, execGh: ExecGhFn): OpenPrResult {
  let prNumber = input.prNumber;
  let resolvedFromBranch = false;

  if (!prNumber) {
    if (!input.headBranch) {
      return { kind: 'needsHuman', verdict: 'unresolved', lesson: 'ci-poller step has neither pr_number nor head_branch - cannot identify a PR to watch' };
    }
    const r = resolvePrByBranch(input.repo, input.headBranch, baseBranch, execGh);
    if ('needsHuman' in r) return { kind: 'needsHuman', verdict: 'unresolved', lesson: r.lesson };
    prNumber = r.pr_number;
    resolvedFromBranch = true;
  }

  let prView: PrViewData;
  try {
    prView = fetchPrView(prNumber, input.repo, execGh);
  } catch (err) {
    if (!input.headBranch || resolvedFromBranch || !NOT_FOUND_RE.test(String(err))) {
      throw err;
    }
    const r = resolvePrByBranch(input.repo, input.headBranch, baseBranch, execGh);
    if ('needsHuman' in r) return { kind: 'needsHuman', verdict: 'unresolved', lesson: r.lesson };
    prNumber = r.pr_number;
    resolvedFromBranch = true;
    prView = fetchPrView(prNumber, input.repo, execGh);
  }

  if (prView.state === 'MERGED') return { kind: 'merged', prNumber, prView };
  if (prView.state === 'CLOSED') return handleClosedPr(prNumber, resolvedFromBranch, input, baseBranch, execGh, prView);
  return { kind: 'open', prNumber, prView };
}

function isTerminal(item: UnknownCheckNode): boolean {
  if (item.__typename === 'CheckRun') return item.status === 'COMPLETED';
  return item.state !== 'PENDING';
}

function isPassed(item: UnknownCheckNode): boolean {
  if (item.__typename === 'CheckRun') {
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(item.conclusion ?? '');
  }
  return item.state === 'SUCCESS';
}

function checkName(item: UnknownCheckNode): string {
  if (item.__typename === 'CheckRun') return item.name ?? 'unknown';
  return item.context ?? item.name ?? 'unknown';
}

function checkResult(item: UnknownCheckNode): string {
  if (item.__typename === 'CheckRun') {
    return item.status === 'COMPLETED' ? (item.conclusion ?? 'unknown') : (item.status ?? 'unknown');
  }
  return item.state ?? 'unknown';
}

function isBot(user: { login: string; type?: string } | null | undefined): boolean {
  return user?.type === 'Bot';
}

export function collectCiChecks(
  items: UnknownCheckNode[],
): { pending: boolean; ci_passed: boolean; checks: Array<{ name: string; result: string }>; pendingNames: string[] } {
  const pending = items.length === 0 || items.some((item) => !isTerminal(item));
  const ci_passed = !pending && items.every((item) => isPassed(item));
  const pendingNames = items
    .filter((item) => !isTerminal(item))
    .map(checkName);
  const checks = items.map((item) => ({ name: checkName(item), result: checkResult(item) }));
  return { pending, ci_passed, checks, pendingNames };
}

export type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string;
  line?: number;
  author?: string;
  body: string;
  url?: string;
};

function compactBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mapReviewThreads(raw: unknown): ReviewThread[] {
  const root = asRecord(raw);
  const repository = asRecord(root?.['repository']);
  const pullRequest = asRecord(repository?.['pullRequest']);
  const reviewThreads = asRecord(pullRequest?.['reviewThreads']);
  const nodes = Array.isArray(reviewThreads?.['nodes']) ? reviewThreads.nodes : [];
  return nodes.flatMap((node): ReviewThread[] => {
    const thread = asRecord(node);
    if (!thread) return [];
    const comments = asRecord(thread.comments);
    const firstComment = Array.isArray(comments?.['nodes']) ? asRecord(comments.nodes[0]) : null;
    const author = asRecord(firstComment?.['author']);
    return [{
      id: asStr(thread.id),
      isResolved: Boolean(thread.isResolved),
      isOutdated: Boolean(thread.isOutdated),
      path: asStr(thread.path) || undefined,
      line: typeof thread.line === 'number' ? thread.line : undefined,
      author: asStr(author?.['login']) || undefined,
      body: compactBody(asStr(firstComment?.['body'])),
      url: asStr(firstComment?.['url']) || undefined,
    }];
  });
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`repo must use owner/name format: ${repo}`);
  return { owner, name };
}

function fetchReviewThreads(repo: string, prNumber: number, execGh: ExecGhFn): ReviewThread[] {
  const { owner, name } = splitRepo(repo);
  const raw = execGh([
    'api', 'graphql',
    '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id,isResolved,isOutdated,path,line,comments(first:1){nodes{body,url,author{login}}}}}}}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `number=${prNumber}`,
  ]);
  return mapReviewThreads(parseGhJson<unknown>(raw, `review-threads #${prNumber}`));
}

/** Map the statusCheckRollup contexts GraphQL payload to the SET of check names branch protection
 *  marks REQUIRED. The check name matches {@link checkName}'s convention so it joins cleanly against
 *  CI failure names: CheckRun → `name`, StatusContext → `context`. */
function mapRequiredCheckNames(raw: unknown): Set<string> {
  const root = asRecord(raw);
  const repository = asRecord(root?.['repository']);
  const pullRequest = asRecord(repository?.['pullRequest']);
  const rollup = asRecord(pullRequest?.['statusCheckRollup']);
  const contexts = asRecord(rollup?.['contexts']);
  const nodes = Array.isArray(contexts?.['nodes']) ? contexts.nodes : [];
  const required = new Set<string>();
  for (const node of nodes) {
    const ctx = asRecord(node);
    if (!ctx || ctx['isRequired'] !== true) continue;
    // CheckRun carries `name`; StatusContext carries `context` — mirror checkName().
    const checkName = asStr(ctx['name']) || asStr(ctx['context']);
    if (checkName) required.add(checkName);
  }
  return required;
}

/**
 * fetchRequiredCheckNames — the SET of check names branch protection marks REQUIRED for this PR.
 *
 * `gh pr view --json statusCheckRollup` (fetchPrView) does NOT carry isRequired, so this issues a
 * dedicated GraphQL read mirroring {@link fetchReviewThreads}. `isRequired` lives on
 * StatusCheckRollupContext and needs the `pullRequestNumber:` arg. Used by pollPr to limit the
 * `ci_changes` verdict to required-check failures (advisory checks — Sonar/CodeRabbit — must not
 * trigger a rework loop). Throws on a gh error so callers can apply the fail-safe fallback.
 */
export function fetchRequiredCheckNames(repo: string, prNumber: number, execGh: ExecGhFn): Set<string> {
  const { owner, name } = splitRepo(repo);
  const raw = execGh([
    'api', 'graphql',
    '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name isRequired(pullRequestNumber:$number)} ... on StatusContext{context isRequired(pullRequestNumber:$number)}}}}}}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `number=${prNumber}`,
  ]);
  return mapRequiredCheckNames(parseGhJson<unknown>(raw, `required-checks #${prNumber}`));
}

function collectReviewThreads(input: PrReadinessInput, prNumber: number, execGh: ExecGhFn): PrReadinessResult['reviewThreads'] {
  const threads = input.includeReviewThreads === false ? [] : fetchReviewThreads(input.repo, prNumber, execGh);
  const unresolved = threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
  return {
    included: input.includeReviewThreads !== false,
    unresolvedCount: unresolved.length,
    items: unresolved.slice(0, 20),
  };
}

function fetchComments(input: PrReadinessInput, prNumber: number, execGh: ExecGhFn) {
  if (input.includeComments === false) {
    return { human_reviews: [], human_comments: [], bot_comments: [], coderabbit_reviews: [] };
  }

  const reviewsRaw = execGh(['api', `repos/${input.repo}/pulls/${prNumber}/reviews`]);
  const reviews = parseGhJson<ReviewEntry[]>(reviewsRaw, `reviews #${prNumber}`);

  const reviewCommentsRaw = execGh(['api', `repos/${input.repo}/pulls/${prNumber}/comments`]);
  const reviewComments = parseGhJson<CommentEntry[]>(reviewCommentsRaw, `review-comments #${prNumber}`);

  const issueCommentsRaw = execGh(['api', `repos/${input.repo}/issues/${prNumber}/comments`]);
  const issueComments = parseGhJson<CommentEntry[]>(issueCommentsRaw, `issue-comments #${prNumber}`);
  const allComments = [...reviewComments, ...issueComments];

  // reviews come back chronological; keep only the latest per author so a stale review never
  // overrides a newer one. Mirror this for CodeRabbit (a Bot author, hence excluded from the human
  // map) — otherwise a stale actionable CodeRabbit body keeps a PR stuck even after a newer clean
  // review (#142 Finding #2).
  const latestHumanReviewByAuthor = new Map<string, ReviewEntry>();
  const latestCodeRabbitReviewByAuthor = new Map<string, ReviewEntry>();
  for (const review of reviews) {
    if (!review.user) continue;
    if (isBot(review.user)) {
      if (isCodeRabbit(review.user)) latestCodeRabbitReviewByAuthor.set(review.user.login, review);
      continue;
    }
    latestHumanReviewByAuthor.set(review.user.login, review);
  }

  return {
    human_reviews: [...latestHumanReviewByAuthor.values()],
    human_comments: allComments.filter((comment) => !isBot(comment.user)),
    bot_comments: allComments.filter((comment) => isBot(comment.user)),
    // CodeRabbit review bodies are excluded from human_reviews above (they are Bot-authored). They
    // carry actionable findings as a top-level review body, so keep them for buildFeedback (#142).
    coderabbit_reviews: [...latestCodeRabbitReviewByAuthor.values()],
  };
}

function isCodeRabbit(user: { login: string } | null | undefined): boolean {
  return (user?.login.toLowerCase() ?? '').includes('coderabbit');
}

type CodeRabbitWaitReason = 'provider_limit' | 'review_in_progress' | 'skipped' | 'no_actionable_comments' | '';

/** Classify a single CodeRabbit body into a non-actionable provider-WAIT reason (or '' for none).
 *  Single source of truth shared by codeRabbitCommentReason (drives providerWait) and
 *  isCodeRabbitActionable (so a provider-wait body is never ALSO emitted as a developerFix — #144). */
function codeRabbitProviderWaitReason(rawBody: string): CodeRabbitWaitReason {
  const body = rawBody.toLowerCase();
  if (/rate.limit|provider.limit|quota|capacity|temporar/.test(body) && /did not start|could not start|not start|unable to start|paused/.test(body)) {
    return 'provider_limit';
  }
  if (/review in progress|reviewing|processing/.test(body)) return 'review_in_progress';
  if (/skipped|did not review|no files to review/.test(body)) return 'skipped';
  if (/no actionable comments|no issues found|looks good/.test(body)) return 'no_actionable_comments';
  return '';
}

function codeRabbitCommentReason(comments: CommentEntry[]): CodeRabbitWaitReason {
  for (const comment of comments) {
    if (!isCodeRabbit(comment.user)) continue;
    const reason = codeRabbitProviderWaitReason(comment.body);
    if (reason) return reason;
  }
  return '';
}

/** Best-effort extraction of a "retry in N <unit>" hint from a bot comment body, e.g.
 *  "retry in 10 min". Returns null when no hint is present — the caller must keep the
 *  raw evidence either way. Case-insensitive and intentionally lenient. */
function extractResumeHint(comments: CommentEntry[]): string | null {
  for (const comment of comments) {
    if (!isCodeRabbit(comment.user)) continue;
    const match = comment.body.match(/\/retry[^.]*?(\d+)\s*(min|minute|hour|sec)/i);
    if (match) {
      const unit = match[2].toLowerCase().startsWith('min') ? 'min' : match[2].toLowerCase().startsWith('hour') ? 'hour' : 'sec';
      return `retry in ${match[1]} ${unit}`;
    }
  }
  return null;
}

// CodeRabbit's own structured markers for a finding that still needs developer action. A review
// body or comment carrying any of these is an actionable blocker — UNLESS it is one of the
// non-actionable states classified by codeRabbitCommentReason (provider_limit / review_in_progress
// / skipped / no_actionable_comments), or it has been addressed/resolved/outdated.
const CODERABBIT_FINDING_MARKERS = [
  /⚠️\s*potential issue/i,
  /🛠️\s*refactor suggestion/i,
  /⚠️\s*outside diff range/i,
  /🧹\s*nitpick/i,
];

// "Actionable comments posted: N" — the count CodeRabbit prints atop a review summary. N>0 means
// the review found work; N=0 (handled as no_actionable_comments) is explicitly NOT a blocker.
const CODERABBIT_ACTIONABLE_COUNT_RE = /actionable comments posted:\s*(\d+)/i;

// A finding CodeRabbit reports as already handled. Anchored to CodeRabbit's own addressed-markers
// rather than bare words so a live finding whose prose merely mentions e.g. "remove these outdated
// comments" or "unresolved promise" survives. Such evidence is stale and must NOT remain a blocker.
const CODERABBIT_ADDRESSED_RE = /✅\s*addressed|\baddressed in\b|marked as resolved|now outdated|marked (?:as )?outdated/i;

/** True when a CodeRabbit review-body / comment text reports a finding that still needs developer
 *  action. Conservative — returns false (item dropped, not kept as a blocker) when the body is:
 *  an explicit `Actionable comments posted: 0`; a non-actionable provider-WAIT state (so a wait is
 *  never ALSO a developerFix — #144); or carries an addressed/resolved/outdated marker. */
function isCodeRabbitActionable(body: string): boolean {
  const countMatch = body.match(CODERABBIT_ACTIONABLE_COUNT_RE);
  if (countMatch && Number(countMatch[1]) === 0) return false;
  if (codeRabbitProviderWaitReason(body) !== '') return false;
  if (CODERABBIT_ADDRESSED_RE.test(body)) return false;
  if (countMatch && Number(countMatch[1]) > 0) return true;
  return CODERABBIT_FINDING_MARKERS.some((marker) => marker.test(body));
}

/** Actionable CodeRabbit feedback that arrives as a top-level review body or bot comment rather
 *  than a resolvable GraphQL review thread. `fetchComments` already retrieves this data (bot reviews
 *  and bot comments) but buildFeedback never routed it to developerFixes; an actual finding therefore
 *  vanished (#142). Review bodies come from the `reviews` REST call independent of includeReviewThreads,
 *  so this also covers the poll path. The non-actionable provider states (provider_limit /
 *  review_in_progress / skipped / no_actionable_comments) stay with providerWait — they are excluded
 *  here so the WAIT and FIXES buckets never collapse (#144).
 *
 *  `threadLocations` carries the path:line of unresolved review threads already emitted as the
 *  richer `review_thread` developerFix; a bot comment at the same location is the SAME inline
 *  finding (the thread's first comment), so it is skipped to avoid emitting it twice (#142
 *  Finding #1). Only non-empty locations dedup — a comment with no path:line is never matched. */
function codeRabbitActionableFeedback(
  reviews: ReviewEntry[],
  botComments: CommentEntry[],
  threadLocations: ReadonlySet<string> = new Set(),
): DeveloperFix[] {
  const items: DeveloperFix[] = [];

  for (const review of reviews) {
    if (!isCodeRabbit(review.user) || !isCodeRabbitActionable(review.body)) continue;
    items.push({
      source: 'coderabbit_review_body',
      summary: compactBody(review.body),
      author: review.user?.login ?? '',
      location: '',
      evidence: compactBody(review.body),
    });
  }

  for (const comment of botComments) {
    if (!isCodeRabbit(comment.user) || !isCodeRabbitActionable(comment.body)) continue;
    const location = locationOf(comment);
    if (location && threadLocations.has(location)) continue;
    items.push({
      source: 'coderabbit_comment',
      summary: compactBody(comment.body),
      author: comment.user?.login ?? '',
      location,
      evidence: compactBody(comment.body),
    });
  }

  return items;
}

function compactCheckLists(checks: Array<{ name: string; result: string }>) {
  const terminal: string[] = [];
  const pending: string[] = [];
  const pass: string[] = [];
  const fail: string[] = [];
  for (const check of checks) {
    if (['QUEUED', 'IN_PROGRESS', 'PENDING'].includes(check.result)) {
      pending.push(check.name);
      continue;
    }
    terminal.push(check.name);
    if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.result)) pass.push(check.name);
    else fail.push(check.name);
  }
  return { terminal, pending, pass, fail, list: checks };
}

function providerState(checks: Array<{ name: string; result: string }>, botComments: CommentEntry[]) {
  const codeRabbitCheck = checks.find((check) => check.name.toLowerCase().includes('coderabbit'));
  const commentReason = codeRabbitCommentReason(botComments);
  const statusSuccess = codeRabbitCheck?.result === 'SUCCESS';
  if (commentReason === 'provider_limit') {
    return {
      codeRabbit: {
        state: 'waiting',
        reason: 'provider_limit',
        statusContext: codeRabbitCheck?.result ?? '',
        evidence: 'CodeRabbit status was green, but the top-level bot comment says review did not start because of provider or rate limits.',
      },
    };
  }
  if (commentReason) {
    return {
      codeRabbit: {
        state: commentReason === 'no_actionable_comments' ? 'complete' : 'waiting',
        reason: commentReason,
        statusContext: codeRabbitCheck?.result ?? '',
      },
    };
  }
  if (codeRabbitCheck) {
    return {
      codeRabbit: {
        state: statusSuccess ? 'complete' : 'waiting',
        reason: statusSuccess ? 'status_success' : 'status_pending_or_failed',
        statusContext: codeRabbitCheck.result,
      },
    };
  }
  return {};
}

function locationOf(item: { component?: string; path?: string; line?: number }) {
  const path = item.path ?? item.component ?? '';
  return item.line ? `${path}:${item.line}` : path;
}

/** A single developer-fix feedback item. Sources (ci / sonar / sonar_hotspot / human_review /
 *  review_thread / coderabbit_review_body / coderabbit_comment) populate the optional fields they
 *  have; the shape is a superset mirroring the generic PrFeedbackItemModel so a heterogeneous bucket
 *  stays one coherent type. */
export type DeveloperFix = {
  source: string;
  summary: string;
  evidence: string;
  severity?: string;
  location?: string;
  author?: string;
};

/** A single provider-wait feedback item. `nature` distinguishes the two cases:
 *  - 'informational': a stale comment-derived wait observed on the terminal path (NOT blocking).
 *  - 'blocking': a genuinely-pending provider check observed on the pending path (blocking). */
export type ProviderWaitItem = {
  provider: string;
  reason: string;
  evidence: string;
  blocking: boolean;
  nature: 'informational' | 'blocking';
  resumeAfter: string | null;
};

function providerWaitFeedback(state: ReturnType<typeof providerState>, botComments: CommentEntry[]): ProviderWaitItem[] {
  const codeRabbit = state.codeRabbit;
  if (codeRabbit?.state !== 'waiting') return [];
  // This function is reached on the TERMINAL path (collectPrReadiness only calls buildFeedback
  // after the ci.pending gate). By then any CodeRabbit check is terminal, so a rate-limit /
  // review-in-progress BOT COMMENT is necessarily stale relative to the current green head —
  // it is informational, NOT a readiness blocker. A genuinely-pending CodeRabbit check is
  // caught earlier by the pending gate and surfaced as a blocking providerWait (see
  // buildWaitingReadiness), so the two cases are distinguishable via `blocking`.
  return [{
    provider: 'CodeRabbit',
    reason: codeRabbit.reason,
    evidence: codeRabbit.evidence ?? codeRabbit.statusContext,
    blocking: false,
    nature: 'informational',
    resumeAfter: extractResumeHint(botComments),
  }];
}

function buildFeedback(input: {
  checks: ReturnType<typeof compactCheckLists>;
  providerState: ReturnType<typeof providerState>;
  sonar: PrReadinessResult['sonar'];
  reviewDecision: string;
  reviewThreads: PrReadinessResult['reviewThreads'];
  humanReviews: ReviewEntry[];
  humanComments: CommentEntry[];
  botComments: CommentEntry[];
  coderabbitReviews?: ReviewEntry[];
}) {
  const developerFixes: DeveloperFix[] = [
    ...input.checks.fail.map((name) => ({ source: 'ci', summary: `Fix failing check: ${name}`, evidence: name })),
    ...input.sonar.issues.map((issue) => ({
      source: 'sonar',
      summary: issue.message,
      severity: issue.severity,
      location: locationOf(issue),
      evidence: issue.rule ?? issue.component,
    })),
    ...input.sonar.hotspots.map((hotspot) => ({
      source: 'sonar_hotspot',
      summary: hotspot.message,
      severity: hotspot.vulnerabilityProbability ?? '',
      location: locationOf(hotspot),
      evidence: hotspot.securityCategory ?? hotspot.component,
    })),
    ...input.humanReviews
      .filter((review) => review.state === 'CHANGES_REQUESTED')
      .map((review) => ({
        source: 'human_review',
        summary: compactBody(review.body),
        author: review.user?.login ?? '',
        evidence: review.state,
      })),
    ...input.reviewThreads.items.map((thread) => ({
      source: 'review_thread',
      summary: thread.body,
      author: thread.author ?? '',
      location: locationOf(thread),
      evidence: thread.url ?? thread.id,
    })),
    // Actionable CodeRabbit feedback delivered as a review body / bot comment rather than a
    // resolvable review thread (#142). Appended after review_thread items so the thread-aware
    // classification keeps producing the leading developerFix where threads are present. Pass the
    // thread path:line locations so a bot comment for a thread already emitted above is not
    // emitted a second time (#142 Finding #1).
    ...codeRabbitActionableFeedback(
      input.coderabbitReviews ?? [],
      input.botComments,
      new Set(input.reviewThreads.items.map((thread) => locationOf(thread)).filter((loc) => loc !== '')),
    ),
  ];

  const reviewerQuestions = input.humanComments
    .filter((comment) => comment.body.includes('?'))
    .map((comment) => ({
      source: 'human_comment',
      summary: compactBody(comment.body),
      author: comment.user?.login ?? '',
      location: locationOf(comment),
    }));

  const providerWait = providerWaitFeedback(input.providerState, input.botComments);

  const humanDecisions = [
    ...(input.reviewDecision && input.reviewDecision !== 'APPROVED'
      ? [{ source: 'github_review_decision', summary: `Review decision is ${input.reviewDecision}` }]
      : []),
    ...(input.sonar.unavailable ? [{ source: 'sonar', summary: 'Sonar was configured but unavailable.' }] : []),
  ];

  const ignoredNoise = input.botComments
    .filter((comment) => !comment.user?.login.toLowerCase().includes('coderabbit'))
    .map((comment) => ({ source: comment.user?.login ?? 'bot', summary: compactBody(comment.body) }));

  const residualRisks = [
    ...(input.reviewThreads.included ? [] : ['Review threads were not requested.']),
    ...(input.sonar.unavailable ? ['Sonar findings could not be fetched.'] : []),
  ];

  return { developerFixes, reviewerQuestions, providerWait, humanDecisions, ignoredNoise, residualRisks };
}

export type PrReadinessResult = {
  verdict: PrReadinessVerdict;
  pr: {
    number: number | null;
    url: string;
    state: string;
    draft: boolean;
    base: string;
    head: string;
    headSha: string;
    mergeState: string;
  };
  checks: {
    terminal: string[];
    pending: string[];
    pass: string[];
    fail: string[];
    list: Array<{ name: string; result: string }>;
  };
  reviewDecision: string;
  reviewThreads: {
    included: boolean;
    unresolvedCount: number;
    items: ReviewThread[];
  };
  providerState: ReturnType<typeof providerState>;
  sonar: {
    configured: boolean;
    issues: SonarIssue[];
    hotspots: SonarHotspot[];
    unavailable: boolean;
  };
  nextAction: PrReadinessNextAction;
  evidence: string[];
  feedback: ReturnType<typeof buildFeedback>;
  ciSummary: CiSummary;
};

function emptyPr(prNumber?: number, state = ''): PrReadinessResult['pr'] {
  return {
    number: prNumber ?? null,
    url: '',
    state,
    draft: false,
    base: '',
    head: '',
    headSha: '',
    mergeState: '',
  };
}

function prFromView(prNumber: number, view?: PrViewData): PrReadinessResult['pr'] {
  return {
    number: view?.number ?? prNumber,
    url: view?.url ?? '',
    state: view?.state ?? '',
    draft: view?.isDraft === true,
    base: view?.baseRefName ?? '',
    head: view?.headRefName ?? '',
    headSha: view?.headRefOid ?? '',
    mergeState: view?.mergeStateStatus ?? '',
  };
}

function emptySonar(configured: boolean): PrReadinessResult['sonar'] {
  return { configured, issues: [], hotspots: [], unavailable: false };
}

function emptyReviewThreads(included: boolean): PrReadinessResult['reviewThreads'] {
  return { included, unresolvedCount: 0, items: [] };
}

function emptyCiSummary(ciPassed: boolean): CiSummary {
  return { ci_passed: ciPassed, checks: [], sonar_issues: [], sonar_hotspots_to_review: [], human_reviews: [], human_comments: [], bot_comments: [] };
}

function buildEmptyFeedback(input: {
  sonarConfigured: boolean;
  includeReviewThreads: boolean;
  reviewDecision?: string;
  reviewThreads?: PrReadinessResult['reviewThreads'];
}) {
  return buildFeedback({
    checks: compactCheckLists([]),
    providerState: {},
    sonar: emptySonar(input.sonarConfigured),
    reviewDecision: input.reviewDecision ?? '',
    reviewThreads: input.reviewThreads ?? emptyReviewThreads(input.includeReviewThreads),
    humanReviews: [],
    humanComments: [],
    botComments: [],
  });
}

function buildMergedReadiness(input: PrReadinessInput, resolved: Extract<OpenPrResult, { kind: 'merged' }>): PrReadinessResult {
  const includeReviewThreads = input.includeReviewThreads !== false;
  const sonarConfigured = Boolean(input.sonarProject);
  return {
    verdict: 'merged',
    pr: prFromView(resolved.prNumber, resolved.prView),
    checks: compactCheckLists([]),
    reviewDecision: '',
    reviewThreads: emptyReviewThreads(includeReviewThreads),
    providerState: {},
    sonar: emptySonar(sonarConfigured),
    nextAction: 'none',
    evidence: [`PR #${resolved.prNumber} is merged.`],
    feedback: buildEmptyFeedback({ sonarConfigured, includeReviewThreads }),
    ciSummary: emptyCiSummary(true),
  };
}

function buildNeedsHumanReadiness(input: PrReadinessInput, resolved: Extract<OpenPrResult, { kind: 'needsHuman' }>): PrReadinessResult {
  const includeReviewThreads = input.includeReviewThreads !== false;
  const sonarConfigured = Boolean(input.sonarProject);
  const feedback = buildEmptyFeedback({ sonarConfigured, includeReviewThreads });
  return {
    verdict: resolved.verdict === 'closed' ? 'closed' : 'needs_human',
    pr: resolved.prNumber ? prFromView(resolved.prNumber, resolved.prView) : emptyPr(input.prNumber, resolved.verdict),
    checks: compactCheckLists([]),
    reviewDecision: '',
    reviewThreads: emptyReviewThreads(includeReviewThreads),
    providerState: {},
    sonar: emptySonar(sonarConfigured),
    nextAction: 'human_decision',
    evidence: [resolved.lesson],
    feedback: { ...feedback, humanDecisions: [{ source: 'pr_resolution', summary: resolved.lesson }] },
    ciSummary: emptyCiSummary(false),
  };
}

function buildWaitingReadiness(input: {
  prNumber: number;
  prView: PrViewData;
  checkLists: ReturnType<typeof compactCheckLists>;
  ci: ReturnType<typeof collectCiChecks>;
  reviewThreads: PrReadinessResult['reviewThreads'];
  sonarConfigured: boolean;
  evidence: string[];
  isDraft?: boolean;
}): PrReadinessResult {
  // The pending path previously left providerState empty and built providerWait from it (also
  // empty), so a genuinely-pending CodeRabbit check was never explained as a provider wait.
  // Synthesize a blocking providerState/providerWait from the pending check names so the output
  // surfaces WHY the wait is blocking — mirroring the informational entry emitted on the
  // terminal path. This does not change the verdict (still waiting/watcher_wait).
  const pendingCodeRabbit = input.ci.pendingNames.find((name) => name.toLowerCase().includes('coderabbit'));
  const pendingProviderState: ReturnType<typeof providerState> = pendingCodeRabbit
    ? {
        codeRabbit: {
          state: 'waiting',
          reason: 'check_pending',
          statusContext: 'IN_PROGRESS',
          evidence: 'CodeRabbit check is still pending for the current head — waiting is blocking.',
        },
      }
    : {};

  const feedback = buildFeedback({
    checks: input.checkLists,
    providerState: pendingProviderState,
    sonar: emptySonar(input.sonarConfigured),
    reviewDecision: input.prView.reviewDecision ?? '',
    reviewThreads: input.reviewThreads,
    humanReviews: [],
    humanComments: [],
    botComments: [],
  });

  // buildFeedback -> providerWaitFeedback classifies from providerState, but on the pending path
  // the wait IS blocking (a live check), so emit a blocking item in place of the synthesized one.
  const providerWait: ProviderWaitItem[] = pendingCodeRabbit
    ? [{
        provider: 'CodeRabbit',
        reason: 'check_pending',
        evidence: 'CodeRabbit check is still pending for the current head — waiting is blocking.',
        blocking: true,
        nature: 'blocking',
        resumeAfter: null,
      }]
    : feedback.providerWait;

  return {
    verdict: 'waiting',
    pr: prFromView(input.prNumber, input.prView),
    checks: input.checkLists,
    reviewDecision: input.prView.reviewDecision ?? '',
    reviewThreads: input.reviewThreads,
    providerState: pendingProviderState,
    sonar: emptySonar(input.sonarConfigured),
    nextAction: 'watcher_wait',
    evidence: input.evidence,
    feedback: { ...feedback, providerWait },
    ciSummary: {
      ci_passed: false,
      checks: input.ci.checks,
      ...(input.isDraft ? { isDraft: true } : {}),
      sonar_issues: [],
      sonar_hotspots_to_review: [],
      human_reviews: [],
      human_comments: [],
      bot_comments: [],
    },
  };
}

function readinessAction(input: {
  ci: ReturnType<typeof collectCiChecks>;
  feedback: ReturnType<typeof buildFeedback>;
}): { verdict: PrReadinessVerdict; nextAction: PrReadinessNextAction } {
  // NOTE: a CodeRabbit provider_limit / review_in_progress bot comment is intentionally NOT a
  // `waiting` verdict here. This function is only reached after the ci.pending gate (see
  // collectPrReadiness), so every check is already terminal — such a comment is stale relative
  // to the current green head and is surfaced as an informational providerWait instead. A
  // genuinely-pending CodeRabbit check is handled by the pending gate before this point.
  if (!input.ci.ci_passed || input.feedback.developerFixes.length > 0) {
    return { verdict: 'needs_work', nextAction: 'developer_fix' };
  }
  if (input.feedback.reviewerQuestions.length > 0) {
    return { verdict: 'needs_human', nextAction: 'reviewer_triage' };
  }
  if (input.feedback.humanDecisions.length > 0) {
    return { verdict: 'needs_human', nextAction: 'human_decision' };
  }
  return { verdict: 'ready', nextAction: 'ready_for_merge_gate' };
}

export async function collectPrReadiness(
  input: PrReadinessInput,
  execGh: ExecGhFn = defaultExecGh,
  fetchSonar: FetchSonarFn = defaultFetchSonar,
): Promise<PrReadinessResult> {
  const baseBranch = input.baseBranch ?? 'master';
  const resolved = resolveOpenPr(input, baseBranch, execGh);

  if (resolved.kind === 'merged') {
    return buildMergedReadiness(input, resolved);
  }

  if (resolved.kind === 'needsHuman') {
    return buildNeedsHumanReadiness(input, resolved);
  }

  const { prNumber, prView } = resolved;
  const checks = prView.statusCheckRollup ?? [];
  const ci = collectCiChecks(checks);
  const checkLists = compactCheckLists(ci.checks);
  const reviewThreads = collectReviewThreads(input, prNumber, execGh);
  const sonarConfigured = Boolean(input.sonarProject);

  if (prView.isDraft === true) {
    return buildWaitingReadiness({
      prNumber,
      prView,
      checkLists,
      ci,
      reviewThreads,
      sonarConfigured,
      evidence: [`PR #${prNumber} is still draft.`],
      isDraft: true,
    });
  }

  if (ci.pending) {
    return buildWaitingReadiness({
      prNumber,
      prView,
      checkLists,
      ci,
      reviewThreads,
      sonarConfigured,
      evidence: ci.pendingNames.length > 0 ? [`Pending checks: ${ci.pendingNames.join(', ')}`] : ['No check rollup entries are registered yet.'],
    });
  }

  const sonar = input.sonarProject
    ? await fetchSonar(input.sonarProject, prNumber)
    : { issues: [], hotspots: [], unavailable: false };
  const comments = fetchComments(input, prNumber, execGh);
  const providers = providerState(ci.checks, comments.bot_comments);
  const sonarSummary = {
    configured: Boolean(input.sonarProject),
    issues: sonar.issues,
    hotspots: sonar.hotspots,
    unavailable: sonar.unavailable,
  };
  const feedback = buildFeedback({
    checks: checkLists,
    providerState: providers,
    sonar: sonarSummary,
    reviewDecision: prView.reviewDecision ?? '',
    reviewThreads,
    humanReviews: comments.human_reviews,
    humanComments: comments.human_comments,
    botComments: comments.bot_comments,
    coderabbitReviews: comments.coderabbit_reviews,
  });
  const ciSummary: CiSummary = {
    ci_passed: ci.ci_passed,
    checks: ci.checks,
    mergeStateStatus: prView.mergeStateStatus,
    reviewDecision: prView.reviewDecision,
    mergeable: prView.mergeable,
    sonar_issues: sonar.issues,
    sonar_hotspots_to_review: sonar.hotspots,
    human_reviews: comments.human_reviews,
    human_comments: comments.human_comments,
    bot_comments: comments.bot_comments,
    ...(sonar.unavailable ? { sonar_unavailable: true } : {}),
  };

  const { verdict, nextAction } = readinessAction({ ci, feedback });
  const hasInformationalProviderWait = feedback.providerWait.some((item) => item.blocking === false);

  return {
    verdict,
    pr: prFromView(prNumber, prView),
    checks: checkLists,
    reviewDecision: prView.reviewDecision ?? '',
    reviewThreads,
    providerState: providers,
    sonar: sonarSummary,
    nextAction,
    evidence: [
      `PR #${prNumber} state=${prView.state ?? 'unknown'} draft=${Boolean(prView.isDraft)}`,
      `checks pass=${checkLists.pass.length} fail=${checkLists.fail.length} pending=${checkLists.pending.length}`,
      ...(providers.codeRabbit?.reason === 'provider_limit' ? ['CodeRabbit provider/rate limit comment detected.'] : []),
      ...(verdict === 'ready' && hasInformationalProviderWait
        ? ['Provider wait is informational (stale CodeRabbit rate-limit comment); not blocking readiness.']
        : []),
    ],
    feedback,
    ciSummary,
  };
}

export function toReadinessInput(input: PollInput): PrReadinessInput {
  return {
    repo: input.repo,
    prNumber: input.pr_number,
    headBranch: input.head_branch,
    baseBranch: input.base_branch,
    sonarProject: input.sonar_project,
    includeComments: true,
    includeReviewThreads: false,
  };
}
