import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonFilterDto } from '@revisium/client';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import type { Step } from '../control-plane/steps.js';
import { toStr } from '../control-plane/steps.js';
import type { Role } from '../control-plane/definitions.js';

// ADR digest not yet included — deferred to a later plan once structure is established.

export const REVO_CONTEXT_MISSING = 'revo.ContextMissing' as const;

const MAX_PUBLIC_PARAMS_CHARS = 8_000;
const MAX_PLAN_CONTEXT_CHARS = 40_000;

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

function redactText(value: string): string {
  return value
    .replace(
      /(["']?)([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(\1)\s*:\s*(["'])(.*?)\4/gi,
      '$1$2$3: $4[REDACTED]$4',
    )
    .replace(
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*)\s*[:=]\s*([^\s"'`]+)/gi,
      '$1=[REDACTED]',
    );
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
): Promise<string> {
  const scopeRulesSummary = role.scopeRules ? JSON.stringify(role.scopeRules) : '{}';

  const task = await da.getRow('tasks', step.taskId);
  const taskTitle = task ? toStr(task.data.title) : '(unknown task)';
  const taskScope = task ? toStr(task.data.scope) : '';
  const taskRepo = task ? toStr(task.data.repo_ref) : '';
  const publicParams = isRecord(runContext?.params) ? runContext.params : {};
  const planContext = await materializePlanContext(publicParams.planPath, taskRepo);

  // WORKAROUND: JsonFilterDto.equals is typed as { [key: string]: unknown } but accepts scalar
  // strings at runtime; mirrors the cast pattern in claimNextStep/recoverInFlight.
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

  const inputStr = step.input === null ? 'null' : JSON.stringify(step.input);

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

  // 0016 dataflow: the data-driven adapter hydrates `step.input.inputs` with upstream step outputs
  // (e.g. the analyst's plan for a developer/reviewer). Render them as a clear, named section so the
  // agent receives the produced artifacts. Omitted entirely when there are no hydrated inputs (every
  // legacy/no-consumes node), so existing prompts are unchanged.
  const si = step.input;
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
