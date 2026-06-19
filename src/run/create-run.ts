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
  role?: string;
  playbookId?: string;
  pipelineId?: string;
  params?: Record<string, unknown>;
  routeDecision?: Record<string, unknown>;
  executionProfile?: Record<string, unknown>;
  now?: Date;
  idSuffix?: string;
};

export type CreateRunResult = {
  runId: string;
  taskId: string;
  eventId: string;
  status: 'ready';
};

export type CreatedRunIds = Partial<Pick<CreateRunResult, 'runId' | 'taskId' | 'eventId'>>;

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
  role: string;
  playbookId: string;
  pipelineId: string;
  params: Record<string, unknown>;
  routeDecision: Record<string, unknown>;
  executionProfile: Record<string, unknown>;
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

const DEFAULT_ROLE = 'architect';
const maxRoleRowIdLength = 64;

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

  const role = input.role?.trim() || DEFAULT_ROLE;
  if (!isValidRoleRowId(role)) {
    throw new Error(
      `role must be a well-formed role row id (${maxRoleRowIdLength} chars max, A-Z a-z 0-9 _ -)`,
    );
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
    role,
    playbookId: input.playbookId?.trim() ?? '',
    pipelineId: input.pipelineId?.trim() ?? '',
    params: input.params ?? {},
    routeDecision: input.routeDecision ?? {},
    executionProfile: input.executionProfile ?? {},
    now: input.now ?? new Date(),
    idSuffix: input.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8),
  };
}

// A role row id is generic data: any well-formed id (charset + length) is accepted. Roles are data,
// not a code allow-list — the route binds an installed role row id and the data-driven engine resolves
// it as an opaque capability handle (it holds ZERO role-ids). A hyphen is NOT required (a bare id like
// `developer` is valid).
function isValidRoleRowId(role: string): boolean {
  if (role.length === 0 || role.length > maxRoleRowIdLength) return false;
  return /^[A-Za-z0-9_-]+$/.test(role);
}

function buildIds(input: NormalizedInput): CreateRunResult {
  const stamp = compactUtcStamp(input.now);
  const slug = slugTitle(input.title);
  const stem = `${stamp}_${slug}_${input.idSuffix}`;
  return {
    runId: `run_${stem}`,
    taskId: `task_${stem}`,
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
      playbook_id: normalized.playbookId,
      pipeline_id: normalized.pipelineId,
      params: normalized.params,
      route_decision: normalized.routeDecision,
      execution_profile: normalized.executionProfile,
      created_by: 'cli',
      created_at: nowIso,
      updated_at: nowIso,
    });
    createdIds.runId = ids.runId;

    await dataAccess.createRow('tasks', ids.taskId, {
      id: ids.taskId,
      run_id: ids.runId,
      repo_ref: normalized.repoRef,
      role_hint: normalized.role,
      title: normalized.title,
      status: 'ready',
      depends_on: [],
      scope: normalized.scope,
      priority: normalized.priority,
      created_at: nowIso,
      updated_at: nowIso,
    });
    createdIds.taskId = ids.taskId;

    // No `steps` row is written: the data-driven engine owns progress in DBOS and synthesizes the
    // per-step `Step` in-memory (RunService.loadPipelineContext). The pre-pivot phantom `plan_run`
    // step row (stuck at `ready` forever, never advanced) was retired here (audit §3.1).
    await dataAccess.createRow('events', ids.eventId, {
      id: ids.eventId,
      run_id: ids.runId,
      task_id: ids.taskId,
      step_id: '',
      type: 'run_created',
      payload: {
        source: 'revo run create',
        title: normalized.title,
        description: normalized.description,
        scope: normalized.scope,
        repo: normalized.repoInfo,
        priority: normalized.priority,
        playbook_id: normalized.playbookId,
        pipeline_id: normalized.pipelineId,
        route_decision: normalized.routeDecision,
        execution_profile: normalized.executionProfile,
        ids: { run_id: ids.runId, task_id: ids.taskId },
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
