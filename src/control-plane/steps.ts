import { randomUUID } from 'node:crypto';
import type { JsonFilterDto } from '@revisium/client';
import type { ControlPlaneDataAccess, ControlPlaneRow } from './data-access.js';
import { ControlPlaneError } from './errors.js';

// ─── public types ───────────────────────────────────────────

export type Step = {
  id: string;
  taskId: string;
  runId: string;
  role: string;
  kind: string;
  status: string;
  input: unknown;
  output: unknown;
  modelProfile: string;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  priority: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  deadReason: string;
};

export type NewStep = {
  taskId: string;
  runId: string;
  role: string;
  kind: string;
  input: unknown;
  modelProfile: string;
  priority?: number;
  maxAttempts?: number;
  dependsOn?: string[];
  runAfter?: string;
};

export type CostRecord = {
  modelProfile: string;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  currency?: string;
};

export type StepClock = { now?: Date; idSuffix?: string; parentStepId?: string };

// ─── internal helpers ────────────────────────────────────────

const CLAIM_CAP = 500;
// Per-step attempt fetch limit during crash recovery; N+1 at startup is acceptable at this scale.
const RECOVERY_ATTEMPT_CAP = 100;

export function compactStamp(date: Date): string {
  const pad = (v: number, l = 2) => String(v).padStart(l, '0');
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

function clockNow(opts?: StepClock): Date {
  return opts?.now ?? new Date();
}

function clockSuffix(opts?: StepClock): string {
  return opts?.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8);
}

// Non-cryptographic FNV-1a 64-bit hash → 16 hex chars. Used to derive a child step id that is
// DETERMINISTIC (same parent + index → same id, so a crash-retry is idempotent) yet BOUNDED in
// length. Revisium rowIds max out at 64 chars; concatenating the parent id per level
// (`${parent}_ch_${i}`) overflowed on deep chains. Not crypto, so it does not trip the
// weak-hash security hotspot.
function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.codePointAt(i) ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}


export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function mapStep(row: ControlPlaneRow): Step {
  const d = row.data;
  return {
    id: row.rowId,
    taskId: toStr(d.task_id),
    runId: toStr(d.run_id),
    role: toStr(d.role),
    kind: toStr(d.kind),
    status: toStr(d.status),
    input: d.input ?? null,
    output: d.output ?? null,
    modelProfile: toStr(d.model_profile),
    runAfter: toStr(d.run_after),
    attemptCount: Number(d.attempt_count ?? 0),
    maxAttempts: Number(d.max_attempts ?? 3),
    priority: Number(d.priority ?? 0),
    leaseOwner: toStr(d.lease_owner),
    leaseExpiresAt: toStr(d.lease_expires_at),
    deadReason: toStr(d.dead_reason),
  };
}

function compareByPriorityThenAge(a: ControlPlaneRow, b: ControlPlaneRow): number {
  const pa = Number(a.data.priority ?? 0);
  const pb = Number(b.data.priority ?? 0);
  if (pb !== pa) return pb - pa;
  const ca = toStr(a.data.created_at);
  const cb = toStr(b.data.created_at);
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return 0;
}

function backoffRunAfter(t: Date, attemptCount: number): string {
  const delayMs = 30_000 * Math.pow(2, attemptCount);
  return new Date(t.getTime() + delayMs).toISOString();
}

// ─── exported verbs ──────────────────────────────────────────

// MVP: single-worker read-then-write is acceptable; atomic claim belongs only here later.
export async function claimNextStep(
  da: ControlPlaneDataAccess,
  workerId: string,
  roles: string[],
  opts?: { leaseTtlMs?: number } & StepClock,
): Promise<Step | null> {
  const t = clockNow(opts);
  const nowIso = t.toISOString();
  const leaseTtlMs = opts?.leaseTtlMs ?? 30_000;
  const leaseExpiresAt = new Date(t.getTime() + leaseTtlMs).toISOString();

  // Server-side: filter status=ready AND role∈roles, sort by priority desc then createdAt asc.
  // WORKAROUND: JsonFilterDto.equals is typed as { [key: string]: unknown } but accepts scalar
  // strings at runtime; the @revisium/client JSON-path scalar-equality type gap requires the cast.
  // run_after <= now CANNOT be pushed server-side: JsonFilterDto.lte is typed as number only and
  // has no string/date counterpart. The in-process filter below is the authoritative gate, bounded
  // by CLAIM_CAP so future-scheduled steps cannot exhaust the cap if they accumulate.
  // In-process: re-apply all predicates for correctness against fake/unconstrained transports.
  const rows = await da.listRows('steps', {
    first: CLAIM_CAP,
    where: {
      AND: [
        { data: { path: 'status', equals: 'ready' as unknown as JsonFilterDto['equals'] } },
        { OR: roles.map((r) => ({ data: { path: 'role', equals: r as unknown as JsonFilterDto['equals'] } })) },
      ],
    },
    orderBy: [
      { field: 'data', direction: 'desc', path: 'priority', type: 'int' },
      { field: 'createdAt', direction: 'asc' },
    ],
  });

  const candidateRow = rows
    .filter((row) => {
      const d = row.data;
      return (
        toStr(d.status) === 'ready' &&
        roles.includes(toStr(d.role)) &&
        (toStr(d.run_after) === '' || toStr(d.run_after) <= nowIso)
      );
    })
    .sort(compareByPriorityThenAge)
    .at(0);

  if (!candidateRow) return null;
  const candidate = mapStep(candidateRow);

  await da.patchRow('steps', candidate.id, [
    { op: 'replace', path: 'status', value: 'claimed' },
    { op: 'replace', path: 'lease_owner', value: workerId },
    { op: 'replace', path: 'lease_expires_at', value: leaseExpiresAt },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { ...candidate, status: 'claimed', leaseOwner: workerId, leaseExpiresAt };
}

export async function startAttempt(
  da: ControlPlaneDataAccess,
  step: Step,
  opts: { workerId: string; modelProfile?: string } & StepClock,
): Promise<{ attemptId: string; idempotencyKey: string }> {
  const t = clockNow(opts);
  const nowIso = t.toISOString();
  const sfx = clockSuffix(opts);
  const st = compactStamp(t);
  const attemptId = `attempt_${st}_${sfx}`;
  const idempotencyKey = `idem_${st}_${sfx}`;

  // Attempt row is written before step status flips to 'running'.
  await da.createRow('attempts', attemptId, {
    id: attemptId,
    step_id: step.id,
    run_id: step.runId,
    worker_id: opts.workerId,
    attempt_no: step.attemptCount + 1,
    status: 'running',
    idempotency_key: idempotencyKey,
    model_profile: opts.modelProfile ?? step.modelProfile,
    input_tokens: 0,
    output_tokens: 0,
    lesson: '',
    error: '',
    started_at: nowIso,
    finished_at: '',
  });

  // Increment attempt_count here so crash recovery (recoverInFlight) sees the correct value
  // even when failStep is never called. failStep reads the same derived value so no double-count.
  await da.patchRow('steps', step.id, [
    { op: 'replace', path: 'status', value: 'running' },
    { op: 'replace', path: 'attempt_count', value: step.attemptCount + 1 },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { attemptId, idempotencyKey };
}

export async function writeResult(
  da: ControlPlaneDataAccess,
  step: Step,
  attemptId: string,
  output: unknown,
  costs: CostRecord[],
  opts?: StepClock,
): Promise<void> {
  const t = clockNow(opts);
  const nowIso = t.toISOString();
  const sfx = clockSuffix(opts);
  const st = compactStamp(t);

  // 1. Close attempt
  await da.patchRow('attempts', attemptId, [
    { op: 'replace', path: 'status', value: 'succeeded' },
    { op: 'replace', path: 'finished_at', value: nowIso },
  ]);

  // 2. Append event
  await da.createRow('events', `event_${st}_step-succeeded_${sfx}`, {
    id: `event_${st}_step-succeeded_${sfx}`,
    run_id: step.runId,
    task_id: step.taskId,
    step_id: step.id,
    type: 'step_succeeded',
    payload: { attempt_id: attemptId },
    actor: 'orchestrator',
    created_at: nowIso,
  });

  // 3. Append cost rows
  for (let i = 0; i < costs.length; i++) {
    const cost = costs[i];
    if (!cost) continue;
    await da.createRow('cost_ledger', `cost_${st}_${sfx}_${i}`, {
      id: `cost_${st}_${sfx}_${i}`,
      run_id: step.runId,
      step_id: step.id,
      attempt_id: attemptId,
      model_profile: cost.modelProfile,
      input_tokens: cost.inputTokens,
      output_tokens: cost.outputTokens,
      cost_amount: cost.costAmount,
      currency: cost.currency ?? 'USD',
      recorded_at: nowIso,
    });
  }

  // 4. Last: flip step status to succeeded, clear lease so terminal state is not misleading
  await da.patchRow('steps', step.id, [
    { op: 'replace', path: 'status', value: 'succeeded' },
    { op: 'replace', path: 'output', value: output },
    { op: 'replace', path: 'lease_owner', value: '' },
    { op: 'replace', path: 'lease_expires_at', value: '' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);
}

export async function createSteps(
  da: ControlPlaneDataAccess,
  steps: NewStep[],
  opts?: StepClock,
): Promise<void> {
  const t = clockNow(opts);
  const nowIso = t.toISOString();
  const sfx = clockSuffix(opts);
  const st = compactStamp(t);

  for (let i = 0; i < steps.length; i++) {
    const ns = steps[i];
    if (!ns) continue;
    // When parentStepId is supplied, derive a deterministic, BOUNDED-length ID from a hash of
    // (parent id + index) so that a crash-and-retry (new attemptId, same parent) regenerates the
    // exact same child IDs (idempotent: ROW_CONFLICT from createRow means it already exists → skip)
    // WITHOUT growing the id per chain level. Concatenating the full parent id per level
    // (`${parent}_ch_${i}`) overflowed Revisium's 64-char rowId limit on deep chains. The id
    // depends ONLY on (parent id, index) — NOT on role — so the retry contract holds even if a
    // re-run yields a different role for the same logical next step, and the length is fixed
    // ("step_" + 16 hex = 21 chars) regardless of role. The 64-bit hash keeps it collision-resistant.
    const childKey = `${opts?.parentStepId ?? ''}:${i}`;
    const stepId = opts?.parentStepId
      ? `step_${fnv1a64Hex(childKey)}`
      : `step_${st}_${ns.role}_${sfx}_${i}`;
    // Steps with unresolved dependencies start 'pending'; promoting them to 'ready' once their
    // depends_on complete is the dependency resolver's job, deferred to a later plan (not Plan 0006).
    const hasDeps = ns.dependsOn !== undefined && ns.dependsOn.length > 0;
    try {
      await da.createRow('steps', stepId, {
        id: stepId,
        task_id: ns.taskId,
        run_id: ns.runId,
        role: ns.role,
        kind: ns.kind,
        status: hasDeps ? 'pending' : 'ready',
        input: ns.input,
        output: null,
        model_profile: ns.modelProfile,
        run_after: ns.runAfter ?? '',
        attempt_count: 0,
        max_attempts: ns.maxAttempts ?? 3,
        priority: ns.priority ?? 0,
        depends_on: ns.dependsOn ?? [],
        lease_owner: '',
        lease_expires_at: '',
        dead_reason: '',
        created_at: nowIso,
        updated_at: nowIso,
      });
    } catch (e) {
      if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT' && opts?.parentStepId) continue;
      throw e;
    }
  }
}

export async function failStep(
  da: ControlPlaneDataAccess,
  step: Step,
  attemptId: string,
  opts: { lesson?: string; error?: string } & StepClock,
): Promise<void> {
  const t = clockNow(opts);
  const nowIso = t.toISOString();
  const sfx = clockSuffix(opts);
  const st = compactStamp(t);

  // 1. Close attempt
  await da.patchRow('attempts', attemptId, [
    { op: 'replace', path: 'status', value: 'failed' },
    { op: 'replace', path: 'lesson', value: opts.lesson ?? '' },
    { op: 'replace', path: 'error', value: opts.error ?? '' },
    { op: 'replace', path: 'finished_at', value: nowIso },
  ]);

  // 2. Append event
  await da.createRow('events', `event_${st}_step-failed_${sfx}`, {
    id: `event_${st}_step-failed_${sfx}`,
    run_id: step.runId,
    task_id: step.taskId,
    step_id: step.id,
    type: 'step_failed',
    payload: { attempt_id: attemptId, lesson: opts.lesson, error: opts.error },
    actor: 'orchestrator',
    created_at: nowIso,
  });

  // 3. Gate on the PERSISTED attempt_count, never the caller's snapshot. startAttempt owns the
  //    increment and already wrote it, so re-deriving here (snapshot + 1) would double-count a step
  //    that the worker refetched between startAttempt and failStep, killing it one attempt early.
  //    failStep therefore reads the current row and does not write attempt_count itself.
  const current = await da.getRow('steps', step.id);
  const attemptCount = Number(current?.data.attempt_count ?? step.attemptCount);
  const maxAttempts = Number(current?.data.max_attempts ?? step.maxAttempts);

  if (attemptCount < maxAttempts) {
    // 4. Attempts remain: backoff to ready, clear lease (attempt_count left as startAttempt set it)
    await da.patchRow('steps', step.id, [
      { op: 'replace', path: 'status', value: 'ready' },
      { op: 'replace', path: 'run_after', value: backoffRunAfter(t, attemptCount) },
      { op: 'replace', path: 'lease_owner', value: '' },
      { op: 'replace', path: 'lease_expires_at', value: '' },
      { op: 'replace', path: 'updated_at', value: nowIso },
    ]);
  } else {
    // 5. Cap reached: dead, clear lease
    const deadReason = opts.lesson ?? opts.error ?? `exhausted ${maxAttempts} attempt(s)`;
    await da.patchRow('steps', step.id, [
      { op: 'replace', path: 'status', value: 'dead' },
      { op: 'replace', path: 'dead_reason', value: deadReason },
      { op: 'replace', path: 'lease_owner', value: '' },
      { op: 'replace', path: 'lease_expires_at', value: '' },
      { op: 'replace', path: 'updated_at', value: nowIso },
    ]);
  }
}

export async function recoverInFlight(
  da: ControlPlaneDataAccess,
  workerId: string,
  opts?: StepClock,
): Promise<Step[]> {
  const t = clockNow(opts);
  const nowIso = t.toISOString();
  const sfx = clockSuffix(opts);
  const st = compactStamp(t);

  // Server-side: filter by lease_owner + status to avoid a full-table scan.
  // MVP single-worker startup: first-page result (CLAIM_CAP rows) is acceptable; a multi-worker
  // deployment would need pagination here, but that belongs to a later plan.
  const allSteps = await da.listRows('steps', {
    first: CLAIM_CAP,
    where: {
      AND: [
        { data: { path: 'lease_owner', equals: workerId as unknown as JsonFilterDto['equals'] } },
        {
          OR: [
            { data: { path: 'status', equals: 'claimed' as unknown as JsonFilterDto['equals'] } },
            { data: { path: 'status', equals: 'running' as unknown as JsonFilterDto['equals'] } },
          ],
        },
      ],
    },
  });
  // In-process filter provides correctness against fake/unconstrained transports.
  const orphans = allSteps
    .map(mapStep)
    .filter((s) => s.leaseOwner === workerId && (s.status === 'claimed' || s.status === 'running'));

  for (let i = 0; i < orphans.length; i++) {
    const orphan = orphans[i];
    if (!orphan) continue;

    if (orphan.status === 'running') {
      const allAttempts = await da.listRows('attempts', { first: RECOVERY_ATTEMPT_CAP });
      const runningAttempts = allAttempts.filter(
        (a) => String(a.data.step_id) === orphan.id && String(a.data.status) === 'running',
      );
      for (const attempt of runningAttempts) {
        await da.patchRow('attempts', attempt.rowId, [
          { op: 'replace', path: 'status', value: 'failed' },
          { op: 'replace', path: 'lesson', value: 'worker crashed mid-step' },
          { op: 'replace', path: 'finished_at', value: nowIso },
        ]);
      }
    }

    await da.createRow('events', `event_${st}_step-recovered_${sfx}_${i}`, {
      id: `event_${st}_step-recovered_${sfx}_${i}`,
      run_id: orphan.runId,
      task_id: orphan.taskId,
      step_id: orphan.id,
      type: 'step_recovered',
      payload: { worker_id: workerId },
      actor: 'orchestrator',
      created_at: nowIso,
    });

    await da.patchRow('steps', orphan.id, [
      { op: 'replace', path: 'status', value: 'ready' },
      { op: 'replace', path: 'lease_owner', value: '' },
      { op: 'replace', path: 'lease_expires_at', value: '' },
      { op: 'replace', path: 'updated_at', value: nowIso },
    ]);
  }

  return orphans;
}
