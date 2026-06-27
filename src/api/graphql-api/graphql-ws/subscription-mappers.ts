import type { ControlPlaneChange } from '../../../control-plane/change-notifications.js';
import type { ControlPlaneRow } from '../../../control-plane/data-access.js';
import { issueRefFromParams } from '../../../run/issue-ref.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function strArr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item));
}

function date(value: unknown): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value;
  if (typeof value !== 'string' || value.length === 0) return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function runStatus(value: unknown): string {
  const status = str(value);
  return status === 'paused' ? 'blocked' : status;
}

export function mapRunRow(row: ControlPlaneRow) {
  const issueRef = issueRefFromParams(row.data.params);
  return {
    id: row.rowId,
    title: str(row.data.title),
    status: runStatus(row.data.status),
    priority: num(row.data.priority),
    description: str(row.data.description) || undefined,
    scope: str(row.data.scope) || undefined,
    repos: strArr(row.data.repos),
    ...(issueRef ? { issueRef } : {}),
    createdAt: date(row.data.created_at ?? row.createdAt),
  };
}

export function mapRunEventRow(row: ControlPlaneRow) {
  return {
    id: row.rowId,
    runId: str(row.data.run_id),
    type: str(row.data.type),
    actor: str(row.data.actor),
    createdAt: date(row.data.created_at ?? row.createdAt),
    taskId: str(row.data.task_id),
    stepId: str(row.data.step_id),
    payload: row.data.payload ?? null,
  };
}

export function mapRunCostRow(row: ControlPlaneRow) {
  return {
    id: row.rowId,
    runId: str(row.data.run_id),
    stepId: str(row.data.step_id),
    attemptId: str(row.data.attempt_id),
    modelProfile: str(row.data.model_profile),
    inputTokens: num(row.data.input_tokens),
    outputTokens: num(row.data.output_tokens),
    costAmount: num(row.data.cost_amount),
    currency: str(row.data.currency),
    recordedAt: date(row.data.recorded_at ?? row.createdAt),
  };
}

export function mapInboxRow(row: ControlPlaneRow) {
  return {
    id: row.rowId,
    kind: str(row.data.kind),
    runId: str(row.data.run_id) || null,
    taskId: str(row.data.task_id) || null,
    stepId: str(row.data.step_id) || null,
    projectId: str(row.data.project_id) || null,
    title: str(row.data.title),
    status: str(row.data.status),
    context: row.data.context ?? null,
    options: row.data.options ?? [],
    answer: row.data.answer ?? null,
    resolvedBy: str(row.data.resolved_by) || null,
    createdAt: date(row.data.created_at ?? row.createdAt),
    resolvedAt: str(row.data.resolved_at) ? date(row.data.resolved_at) : null,
  };
}

export function changeRunId(change: ControlPlaneChange): string {
  if (change.table === 'task_runs') return change.rowId;
  return str(change.row.data.run_id);
}
