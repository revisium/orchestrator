import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess } from '../control-plane/index.js';

export type CreateRunInput = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  priority?: number;
  now?: Date;
  idSuffix?: string;
};

export type CreateRunResult = {
  runId: string;
  taskId: string;
  stepId: string;
  eventId: string;
  status: 'ready';
};

export type CreatedRunIds = Partial<Pick<CreateRunResult, 'runId' | 'taskId' | 'stepId' | 'eventId'>>;

type NormalizedInput = {
  title: string;
  repoRef: string;
  repoInfo: {
    input: string;
    ref: string;
    mode: 'path' | 'name';
  };
  description: string;
  scope: string;
  priority: number;
  now: Date;
  idSuffix: string;
};

export class CreateRunWorkflowError extends Error {
  readonly createdIds: CreatedRunIds;
  readonly cause: unknown;

  constructor(message: string, createdIds: CreatedRunIds, cause: unknown) {
    super(message);
    this.name = 'CreateRunWorkflowError';
    this.createdIds = createdIds;
    this.cause = cause;
  }
}

function compactUtcStamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    'T',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    pad(date.getUTCMilliseconds(), 3),
    'Z',
  ].join('');
}

const maxSlugLength = 21;

function slugTitle(title: string): string {
  let slug = '';
  let needsSeparator = false;
  for (const char of title.toLowerCase()) {
    const isAlphanumeric = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
    if (!isAlphanumeric) {
      needsSeparator = slug.length > 0;
      continue;
    }
    if (needsSeparator && slug.length < maxSlugLength) slug += '-';
    needsSeparator = false;
    if (slug.length < maxSlugLength) slug += char;
    if (slug.length >= maxSlugLength) break;
  }

  while (slug.endsWith('-')) slug = slug.slice(0, -1);
  return slug || 'run';
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function isExplicitPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/');
}

function isDirectory(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function normalizeInput(input: CreateRunInput): NormalizedInput {
  const title = input.title?.trim() ?? '';
  if (!title) throw new Error('title is required');

  const originalRepo = input.repo?.trim() ?? '';
  if (!originalRepo) throw new Error('repo is required');

  const priority = input.priority ?? 0;
  if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
    throw new TypeError('priority must be a finite integer');
  }

  const expandedRepo = expandHome(originalRepo);
  const existingDirectory = isDirectory(expandedRepo);
  if (isExplicitPath(originalRepo) && !existingDirectory) {
    throw new Error(`repo path must exist and be a directory: ${originalRepo}`);
  }

  const repoRef = existingDirectory ? path.resolve(expandedRepo) : originalRepo;
  return {
    title,
    repoRef,
    repoInfo: {
      input: originalRepo,
      ref: repoRef,
      mode: existingDirectory ? 'path' : 'name',
    },
    description: input.description?.trim() ?? '',
    scope: input.scope?.trim() ?? '',
    priority,
    now: input.now ?? new Date(),
    idSuffix: input.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8),
  };
}

function buildIds(input: NormalizedInput): CreateRunResult {
  const stamp = compactUtcStamp(input.now);
  const slug = slugTitle(input.title);
  const stem = `${stamp}_${slug}_${input.idSuffix}`;
  return {
    runId: `run_${stem}`,
    taskId: `task_${stem}`,
    stepId: `step_${stem}`,
    eventId: `event_${stem}_created`,
    status: 'ready',
  };
}

export async function createRunWorkflow(
  dataAccess: ControlPlaneDataAccess,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const normalized = normalizeInput(input);
  await dataAccess.assertReady();

  const ids = buildIds(normalized);
  const createdIds: CreatedRunIds = {};
  const nowIso = normalized.now.toISOString();

  try {
    await dataAccess.createRow('task_runs', ids.runId, {
      id: ids.runId,
      project_id: '',
      title: normalized.title,
      description: normalized.description,
      status: 'ready',
      repos: [normalized.repoRef],
      scope: normalized.scope,
      priority: normalized.priority,
      created_by: 'cli',
      created_at: nowIso,
      updated_at: nowIso,
    });
    createdIds.runId = ids.runId;

    await dataAccess.createRow('tasks', ids.taskId, {
      id: ids.taskId,
      run_id: ids.runId,
      repo_ref: normalized.repoRef,
      role_hint: 'architect',
      title: normalized.title,
      status: 'ready',
      depends_on: [],
      scope: normalized.scope,
      priority: normalized.priority,
      created_at: nowIso,
      updated_at: nowIso,
    });
    createdIds.taskId = ids.taskId;

    await dataAccess.createRow('steps', ids.stepId, {
      id: ids.stepId,
      task_id: ids.taskId,
      run_id: ids.runId,
      role: 'architect',
      kind: 'plan_run',
      status: 'ready',
      input: {
        title: normalized.title,
        description: normalized.description,
        scope: normalized.scope,
        repo: normalized.repoInfo,
        run_id: ids.runId,
        task_id: ids.taskId,
      },
      output: null,
      model_profile: 'standard',
      run_after: '',
      attempt_count: 0,
      max_attempts: 3,
      priority: normalized.priority,
      lease_owner: '',
      lease_expires_at: '',
      dead_reason: '',
      created_at: nowIso,
      updated_at: nowIso,
    });
    createdIds.stepId = ids.stepId;

    await dataAccess.createRow('events', ids.eventId, {
      id: ids.eventId,
      run_id: ids.runId,
      task_id: ids.taskId,
      step_id: ids.stepId,
      type: 'run_created',
      payload: {
        source: 'revo run create',
        title: normalized.title,
        description: normalized.description,
        scope: normalized.scope,
        repo: normalized.repoInfo,
        priority: normalized.priority,
        ids: { run_id: ids.runId, task_id: ids.taskId, step_id: ids.stepId },
      },
      actor: 'cli',
      created_at: nowIso,
    });
    createdIds.eventId = ids.eventId;
  } catch (error) {
    throw new CreateRunWorkflowError('Failed to create run workflow rows', createdIds, error);
  }

  return ids;
}
