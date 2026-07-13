import type { ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import {
  AGENT_OUTPUT_STREAM_EVENT_TYPE,
  AGENT_OUTPUT_STREAM_PREFIX,
  type AgentOutputStreamRegistration,
} from '../observability/types.js';

export type RegisterAgentOutputStreamInput = {
  runId: string;
  taskId: string;
  stepId: string;
  attemptId: string;
};

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

function identifier(value: string, field: keyof RegisterAgentOutputStreamInput): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `${field} must be a safe non-empty identifier of at most 64 characters`);
  }
  return value;
}

const REGISTRATION_DATA_KEYS = ['actor', 'id', 'payload', 'run_id', 'step_id', 'task_id', 'type'];
const REGISTRATION_STORAGE_KEYS = ['created_at', 'sequence'];
const REGISTRATION_PAYLOAD_KEYS = ['attemptId', 'schemaVersion', 'streamKey'];

function exactRegistration(row: ControlPlaneRow, sequence: number): AgentOutputStreamRegistration | null {
  const data = row.data;
  const payload = data.payload;
  if (row.rowId !== data.id || typeof data.id !== 'string' ||
      data.type !== AGENT_OUTPUT_STREAM_EVENT_TYPE || typeof data.run_id !== 'string' ||
      data.actor !== 'orchestrator' ||
      !Object.keys(data).every((key) => REGISTRATION_DATA_KEYS.includes(key) || REGISTRATION_STORAGE_KEYS.includes(key)) ||
      REGISTRATION_DATA_KEYS.some((key) => !Object.hasOwn(data, key)) ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (Object.keys(p).sort().join('|') !== REGISTRATION_PAYLOAD_KEYS.join('|') ||
      p.schemaVersion !== 1 || typeof p.attemptId !== 'string' ||
      p.streamKey !== `${AGENT_OUTPUT_STREAM_PREFIX}${p.attemptId}`) return null;
  return {
    runId: data.run_id,
    taskId: typeof data.task_id === 'string' ? data.task_id : '',
    stepId: typeof data.step_id === 'string' ? data.step_id : '',
    attemptId: p.attemptId,
    sequence,
  };
}

export async function registerAgentOutputStream(
  da: ControlPlaneDataAccess,
  input: RegisterAgentOutputStreamInput,
): Promise<void> {
  const runId = identifier(input.runId, 'runId');
  const taskId = identifier(input.taskId, 'taskId');
  const stepId = identifier(input.stepId, 'stepId');
  const attemptId = identifier(input.attemptId, 'attemptId');
  const eventId = `event_${fnv1a64Hex(`${runId}|${AGENT_OUTPUT_STREAM_EVENT_TYPE}|${attemptId}`)}`;
  const data = {
    id: eventId,
    run_id: runId,
    task_id: taskId,
    step_id: stepId,
    type: AGENT_OUTPUT_STREAM_EVENT_TYPE,
    payload: { schemaVersion: 1, attemptId, streamKey: `${AGENT_OUTPUT_STREAM_PREFIX}${attemptId}` },
    actor: 'orchestrator',
  };
  try {
    await da.createRow('events', eventId, data);
  } catch (error) {
    if (!(error instanceof ControlPlaneError) || error.code !== 'ROW_CONFLICT') throw error;
    const row = await da.getRow('events', eventId);
    if (!row) throw new ControlPlaneError('TRANSPORT_ERROR', `registration conflict row disappeared: ${eventId}`);
    const existing = exactRegistration(row, 1);
    if (existing?.runId === runId && existing.taskId === taskId && existing.stepId === stepId &&
        existing.attemptId === attemptId) return;
    throw new ControlPlaneError('ROW_CONFLICT', `immutable agent output registration conflict: ${eventId}`);
  }
}

export async function listAgentOutputStreamRegistrations(
  da: ControlPlaneDataAccess,
  runId: string,
): Promise<AgentOutputStreamRegistration[]> {
  await da.assertReady();
  const rows: ControlPlaneRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await da.listRows('events', {
      first: 1000,
      ...(after ? { after } : {}),
      orderBy: [{ field: 'sequence', direction: 'asc' }],
      where: { AND: [{ data: { path: 'run_id', equals: runId } }, { data: { path: 'type', equals: AGENT_OUTPUT_STREAM_EVENT_TYPE } }] },
    });
    rows.push(...page);
    if (page.length < 1000) break;
    const nextAfter = page.at(-1)?.cursor;
    if (!nextAfter || nextAfter === after) throw new ControlPlaneError('TRANSPORT_ERROR', 'agent output registration pagination did not advance');
    after = nextAfter;
  }
  const result: AgentOutputStreamRegistration[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const registration = exactRegistration(row, index + 1);
    if (!registration || registration.runId !== runId || seen.has(registration.attemptId) ||
        !IDENTIFIER.test(registration.taskId) || !IDENTIFIER.test(registration.stepId) ||
        !IDENTIFIER.test(registration.attemptId) || registration.attemptId === '') {
      throw new ControlPlaneError('VALIDATION_FAILURE', 'malformed agent output stream registration row');
    }
    seen.add(registration.attemptId);
    result.push(registration);
  }
  return result;
}
