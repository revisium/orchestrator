import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonFilterDto } from '@revisium/client';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import type { Step } from '../control-plane/steps.js';
import { toStr } from '../control-plane/steps.js';
import { isWorktreeDir, worktreePathFor } from '../control-plane/resolve-cwd.js';
import type { Role } from '../control-plane/definitions.js';


export const REVO_CONTEXT_MISSING = 'revo.ContextMissing' as const;

const MAX_PUBLIC_PARAMS_CHARS = 8_000;
const MAX_PLAN_CONTEXT_CHARS = 40_000;
const DEVELOPER_ROLE_IDS = new Set(['developer', 'developer-codex']);
const DEVELOPER_EXPLICIT_PUBLICATION_KEYS = new Set([
  'basebranch',
  'baserefname',
  'foreignpr',
  'headbranch',
  'headrefname',
  'headrefoid',
  'headsha',
  'mergeable',
  'mergestatestatus',
  'prauthor',
  'prnumber',
  'prurl',
  'pullrequestnumber',
  'pullrequesturl',
]);
const DEVELOPER_PULL_REQUEST_OBJECT_KEYS = new Set([
  'author',
  'authorlogin',
  'base',
  'baseref',
  'baserefname',
  'branch',
  'head',
  'headref',
  'headrefname',
  'headsha',
  'isdraft',
  'mergeable',
  'mergestatestatus',
  'number',
  'state',
  'url',
]);
const DEVELOPER_CONTEXTUAL_BRANCH_KEYS = new Set(['base', 'branch', 'head', 'ref', 'refname']);
const GITHUB_PULL_URL_TEXT = /https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i;
const DEVELOPER_PUBLICATION_COMMAND_TEXT = /\bgh\s+pr(?:\s|$)|\bgit\s+push(?:\s|$)/i;
const DEVELOPER_PUBLICATION_ACTION_BEFORE_PR_TEXT =
  /\b(?:open|create|publish|submit|update|edit|merge|close|ready|draft)\b.{0,80}\b(?:PR|pull request)\b/i;
const DEVELOPER_PUBLICATION_PR_BEFORE_METADATA_TEXT =
  /\b(?:PR|pull request)\b.{0,80}\b(?:url|number|head|branch|merge|draft|ready)\b/i;
const DEVELOPER_PR_METADATA_TEXT = /\bPR\b\s+(?:#\d+|number|url|head\s*sha|headSha|head|branch)\b/i;

export type AgentRunContext = {
  description: string;
  params: Record<string, unknown>;
};

export class ContextMissingError extends Error {
  readonly code = REVO_CONTEXT_MISSING;

  constructor(message: string) {
    super(`${REVO_CONTEXT_MISSING}: ${message}`);
    this.name = 'ContextMissingError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)/i.test(key);
}

function bounded(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated: ${String(value.length - maxChars)} chars omitted]`;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === '\'' && value.at(-1) === '\''))) {
    return value.slice(1, -1);
  }
  return value;
}

function firstSeparatorIndex(value: string): number {
  const colon = value.indexOf(':');
  const equals = value.indexOf('=');
  if (colon === -1) return equals;
  if (equals === -1) return colon;
  return Math.min(colon, equals);
}

function leadingWhitespace(value: string): string {
  let i = 0;
  while (i < value.length && (value[i] === ' ' || value[i] === '\t')) i += 1;
  return value.slice(0, i);
}

function redactTextLine(line: string): string {
  const separator = firstSeparatorIndex(line);
  if (separator === -1) return line;
  const key = unquote(line.slice(0, separator).trim());
  if (!isSecretKey(key)) return line;
  const afterSeparator = line.slice(separator + 1);
  const prefix = leadingWhitespace(afterSeparator);
  const rest = afterSeparator.slice(prefix.length);
  const quote = rest[0] === '"' || rest[0] === '\'' ? rest[0] : '';
  return `${line.slice(0, separator + 1)}${prefix}${quote}[REDACTED]${quote}`;
}

function redactText(value: string): string {
  return value.split('\n').map(redactTextLine).join('\n');
}

function redactJsonish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonish);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? '[REDACTED]' : redactJsonish(item);
  }
  return out;
}

function jsonForContext(value: unknown, maxChars: number): string {
  return bounded(redactText(JSON.stringify(redactJsonish(value), null, 2)), maxChars);
}

function normalizedContextKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function isDeveloperRole(role: Role): boolean {
  return DEVELOPER_ROLE_IDS.has(role.name) || (role.playbookRoleId !== undefined && DEVELOPER_ROLE_IDS.has(role.playbookRoleId));
}

function textLooksLikePrMetadata(value: string): boolean {
  const trimmed = value.trim();
  return GITHUB_PULL_URL_TEXT.test(trimmed)
    || /^#?\d+\b/.test(trimmed)
    || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/.test(trimmed);
}

function textLooksLikeGitBranch(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:refs\/heads\/|origin\/)/i.test(trimmed)
    || /^(?:feat|fix|bugfix|chore|docs|test|refactor|codex|revo|issue)[/-]/i.test(trimmed)
    || /^(?:main|master|develop|development|dev|trunk|release(?:[/-][A-Za-z0-9._-]+)?|hotfix[/-][A-Za-z0-9._-]+)$/i.test(trimmed);
}

function textLooksLikePrefixedGitBranch(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:refs\/heads\/|origin\/)/i.test(trimmed)
    || /^(?:feat|fix|bugfix|chore|docs|test|refactor|codex|revo|issue)[/-]/i.test(trimmed);
}

function isPublicationMetadataLine(line: string): boolean {
  if (DEVELOPER_PR_METADATA_TEXT.test(line)) return true;
  const separator = firstSeparatorIndex(line);
  if (separator === -1) return false;
  const key = unquote(line.slice(0, separator).trim());
  const value = line.slice(separator + 1);
  const normalizedKey = normalizedContextKey(key);
  if (DEVELOPER_EXPLICIT_PUBLICATION_KEYS.has(normalizedKey)) return true;
  if (normalizedKey === 'pr' || normalizedKey === 'pullrequest') return textLooksLikePrMetadata(value);
  if (normalizedKey === 'branch') return textLooksLikeGitBranch(value);
  return false;
}

function isPublicationTextLine(line: string): boolean {
  return DEVELOPER_PUBLICATION_COMMAND_TEXT.test(line)
    || GITHUB_PULL_URL_TEXT.test(line)
    || DEVELOPER_PUBLICATION_ACTION_BEFORE_PR_TEXT.test(line)
    || DEVELOPER_PUBLICATION_PR_BEFORE_METADATA_TEXT.test(line)
    || isPublicationMetadataLine(line);
}

function sanitizeDeveloperString(value: string): string | undefined {
  const lines = value.split('\n').filter((line) => !isPublicationTextLine(line));
  const sanitized = lines.join('\n').trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function recordHasPublicationMetadata(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = normalizedContextKey(key);
    if (DEVELOPER_EXPLICIT_PUBLICATION_KEYS.has(normalizedKey)) return true;
    if (normalizedKey === 'pullrequest') return valueLooksLikePullRequestMetadata(item);
    if (normalizedKey === 'pr' || normalizedKey === 'pullrequest') return valueLooksLikePrMetadata(item);
    return false;
  });
}

function valueLooksLikePrMetadata(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value === 'string') return textLooksLikePrMetadata(value);
  return isRecord(value) && recordHasPublicationMetadata(value);
}

function valueLooksLikeStandaloneGitBranch(value: unknown): boolean {
  return typeof value === 'string' && textLooksLikePrefixedGitBranch(value);
}

function valueLooksLikePublicationGitBranch(value: unknown): boolean {
  return typeof value === 'string' && textLooksLikeGitBranch(value);
}

function valueLooksLikePullRequestMetadata(value: unknown): boolean {
  if (!isRecord(value)) return valueLooksLikePrMetadata(value);
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = normalizedContextKey(key);
    if (DEVELOPER_EXPLICIT_PUBLICATION_KEYS.has(normalizedKey)) return true;
    if (!DEVELOPER_PULL_REQUEST_OBJECT_KEYS.has(normalizedKey)) return false;
    if (normalizedKey === 'number') return typeof item === 'number' && Number.isInteger(item) && item > 0;
    if (normalizedKey === 'url') return typeof item === 'string' && textLooksLikePrMetadata(item);
    if (DEVELOPER_CONTEXTUAL_BRANCH_KEYS.has(normalizedKey)) return valueLooksLikePublicationGitBranch(item);
    return item !== undefined && item !== null && item !== '';
  });
}

function isDeveloperPublicationEntry(
  key: string,
  item: unknown,
  parent: Record<string, unknown>,
): boolean {
  const normalizedKey = normalizedContextKey(key);
  if (DEVELOPER_EXPLICIT_PUBLICATION_KEYS.has(normalizedKey)) return true;
  if (normalizedKey === 'pullrequest') {
    return valueLooksLikePullRequestMetadata(item) || valueLooksLikePrMetadata(item) || recordHasPublicationMetadata(parent);
  }
  if (normalizedKey === 'pr') return valueLooksLikePrMetadata(item);
  if (DEVELOPER_CONTEXTUAL_BRANCH_KEYS.has(normalizedKey) && recordHasPublicationMetadata(parent)) {
    return valueLooksLikePublicationGitBranch(item);
  }
  if (normalizedKey === 'branch') return valueLooksLikeStandaloneGitBranch(item);
  return false;
}

function sanitizeDeveloperContext(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeDeveloperString(value);
  if (Array.isArray(value)) {
    return value
      .map(sanitizeDeveloperContext)
      .filter((item) => item !== undefined);
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isDeveloperPublicationEntry(key, item, value)) continue;
    const sanitized = sanitizeDeveloperContext(item);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function contextValueForRole(role: Role, value: unknown): unknown {
  return isDeveloperRole(role) ? sanitizeDeveloperContext(value) : value;
}

function insideOrSame(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function materializePlanContext(planPath: unknown, repoRef: string): Promise<{ path: string; content: string } | null> {
  if (planPath === undefined || planPath === null) return null;
  if (typeof planPath !== 'string' || planPath.trim().length === 0) {
    throw new ContextMissingError('params.planPath must be a non-empty string');
  }
  if (!path.isAbsolute(repoRef)) {
    throw new ContextMissingError('params.planPath requires a local absolute task repo_ref');
  }
  let repoRoot: string;
  try {
    repoRoot = await fs.realpath(path.resolve(repoRef));
  } catch {
    throw new ContextMissingError('params.planPath requires a readable local task repo_ref');
  }
  const workspaceRoot = path.dirname(repoRoot);
  const rawPath = planPath.trim();
  const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(repoRoot, rawPath));
  let realResolved: string;
  try {
    realResolved = await fs.realpath(resolved);
  } catch {
    throw new ContextMissingError(`params.planPath is not readable: ${rawPath}`);
  }
  if (!insideOrSame(workspaceRoot, realResolved)) {
    throw new ContextMissingError(`params.planPath is outside task workspace: ${rawPath}`);
  }
  let stat;
  try {
    stat = await fs.stat(realResolved);
  } catch {
    throw new ContextMissingError(`params.planPath is not readable: ${rawPath}`);
  }
  if (!stat.isFile()) {
    throw new ContextMissingError(`params.planPath is not a file: ${rawPath}`);
  }
  let content: string;
  try {
    content = await fs.readFile(realResolved, 'utf8');
  } catch {
    throw new ContextMissingError(`params.planPath is not readable: ${rawPath}`);
  }
  return { path: realResolved, content: bounded(redactText(content), MAX_PLAN_CONTEXT_CHARS) };
}

export async function buildContext(
  da: ControlPlaneDataAccess,
  step: Step,
  role: Role,
  runContext?: AgentRunContext,
  dataDir?: string,
): Promise<string> {
  const scopeRulesSummary = role.scopeRules ? JSON.stringify(role.scopeRules) : '{}';

  const task = await da.getRow('tasks', step.taskId);
  const taskTitle = task ? toStr(task.data.title) : '(unknown task)';
  const taskScope = task ? toStr(task.data.scope) : '';
  const repoRef = task ? toStr(task.data.repo_ref) : '';
  let taskRepo = repoRef;
  if (dataDir && taskRepo) {
    const worktree = worktreePathFor(dataDir, step.runId);
    if (isWorktreeDir(worktree)) taskRepo = worktree;
  }
  const publicParams = isRecord(runContext?.params) ? runContext.params : {};
  const planContext = await materializePlanContext(publicParams.planPath, repoRef);

  const stepAttempts = await da.listRows('attempts', {
    first: 100,
    where: { data: { path: 'step_id', equals: step.id as unknown as JsonFilterDto['equals'] } },
  });
  const priorLessons = stepAttempts
    .filter(
      (a) =>
        String(a.data.status) === 'failed' &&
        String(a.data.lesson).length > 0,
    )
    .map((a) => String(a.data.lesson));

  const inputForContext = contextValueForRole(role, step.input);
  const inputStr = inputForContext === null ? 'null' : JSON.stringify(inputForContext ?? {});

  const parts: string[] = [
    `## Role: ${role.name}`,
    role.systemPrompt,
    `## Scope rules: ${scopeRulesSummary}`,
    `## Task: ${taskTitle}`,
  ];

  if (taskScope) parts.push(`Scope: ${taskScope}`);
  if (taskRepo) parts.push(`Repo: ${taskRepo}`);
  if (runContext?.description) parts.push('## Run description:', runContext.description);
  parts.push('## Run params (public):', jsonForContext(publicParams, MAX_PUBLIC_PARAMS_CHARS));
  if (planContext) {
    parts.push('## Required context: params.planPath', `Path: ${planContext.path}`, planContext.content);
  }

  if (priorLessons.length > 0) {
    parts.push('## Prior failed attempt lessons:');
    for (const lesson of priorLessons) {
      parts.push(`- ${lesson}`);
    }
  }

  const si = inputForContext;
  const hydrated =
    si !== null && typeof si === 'object' && !Array.isArray(si)
      ? (si as Record<string, unknown>).inputs
      : undefined;
  if (hydrated !== null && typeof hydrated === 'object' && !Array.isArray(hydrated)) {
    const entries = Object.entries(hydrated as Record<string, unknown>);
    if (entries.length > 0) {
      parts.push('## Inputs (from previous steps):');
      for (const [as, value] of entries) {
        parts.push(`### ${as}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      }
    }
  }

  parts.push('## Current step input:', inputStr);

  return parts.join('\n');
}
