/**
 * inbox.ts — CLI commands for managing the human inbox.
 *
 * Routes through InboxService obtained from a per-invocation Revisium-only Nest context
 * (Option A, §3.0). NestJS is lazily imported so the host-free path never loads it.
 *
 * 0004: `revo inbox resolve` is now gate-aware:
 *  - Gate row (kind==='approval' && runId && context.topic∈{'plan','merge'}):
 *    requires --approve|--reject → resolveInbox (table write) + signal (DBOS send)
 *    + park/terminal poll (same as run start). HOST-REQUIRING.
 *  - Non-gate row (question/alert/approval-without-topic): keep 0002 table-only
 *    --answer resolve (no signal, host-free).
 *
 * G6: `registerInbox(program: Command, app?: INestApplicationContext)` — lazy pipeline/engine
 * import. program.ts forwards the same `app?` already threaded into registerRun.
 *
 * Invariant #4: no @revisium/client import in this file (verbs only).
 */
import { Command } from 'commander';
import type { INestApplicationContext } from '@nestjs/common';
import { ControlPlaneError } from '../../control-plane/index.js';
import type { InboxService } from '../../revisium/inbox.service.js';
import type { InboxItem } from '../../control-plane/inbox.js';
import { withRevisiumService } from './revisium-context.js';
import { pollWorkflowState, type PollOpts } from './poll-workflow-state.js';

/** Topics recognized as gate topics (must match AwaitHuman topics). */
const GATE_TOPICS = new Set<string>(['plan', 'merge']);

type ListOptions = {
  status?: string;
  json: boolean;
};

type ResolveOptions = {
  answer?: string;
  approve: boolean;
  reject: boolean;
  by?: string;
  wait?: boolean;
};

function formatCause(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function printHint(error: ControlPlaneError): void {
  if (error.code === 'DAEMON_NOT_RUNNING') {
    console.error('Run: ./bin/revo.js revisium start');
  }
  if (error.code === 'BOOTSTRAP_NOT_APPLIED') {
    console.error('Run: ./bin/revo.js bootstrap --commit');
  }
}

/**
 * withInboxService — thin wrapper around the shared withRevisiumService helper.
 * Opens exactly ONE Nest context per invocation and closes it in finally.
 */
async function withInboxService<T>(fn: (svc: InboxService) => Promise<T>): Promise<T> {
  const { InboxService: InboxServiceClass } = await import('../../revisium/inbox.service.js');
  return withRevisiumService(InboxServiceClass, fn);
}

function formatInboxItem(item: InboxItem): string {
  const lines: string[] = [
    `id        ${item.id}`,
    `kind      ${item.kind}`,
    `status    ${item.status}`,
    `title     ${item.title}`,
    `created   ${item.createdAt}`,
  ];
  if (item.runId) lines.push(`run       ${item.runId}`);
  if (item.stepId) lines.push(`step      ${item.stepId}`);
  if (item.context !== null && item.context !== undefined) {
    lines.push(`context   ${JSON.stringify(item.context)}`);
  }
  if (item.answer !== null && item.answer !== undefined) {
    lines.push(`answer    ${JSON.stringify(item.answer)}`);
  }
  if (item.resolvedBy) lines.push(`resolvedBy ${item.resolvedBy}`);
  if (item.resolvedAt) lines.push(`resolvedAt ${item.resolvedAt}`);
  return lines.join('\n');
}

function formatInboxList(items: InboxItem[]): string {
  const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
  const COL = { id: 42, kind: 11, status: 10, ts: 22 };
  const header =
    pad('ID', COL.id) +
    pad('KIND', COL.kind) +
    pad('STATUS', COL.status) +
    'CREATED                 TITLE';
  const lines = items.map((item) => {
    const ts = item.createdAt ? item.createdAt.slice(0, 19) + 'Z' : '';
    return (
      pad(item.id, COL.id) +
      pad(item.kind, COL.kind) +
      pad(item.status, COL.status) +
      pad(ts, COL.ts) +
      item.title
    );
  });
  const summary = `(${items.length} item${items.length === 1 ? '' : 's'})`;
  return [header, ...lines, summary].join('\n');
}

async function inboxList(options: ListOptions): Promise<void> {
  try {
    const filter = options.status ? { status: options.status as 'pending' | 'resolved' } : undefined;
    const items = await withInboxService((svc) => svc.listInbox(filter));
    if (options.json) {
      process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    } else {
      console.log(formatInboxList(items));
    }
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      console.error(`Error: ${formatCause(error)}`);
      printHint(error);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

async function inboxShow(id: string): Promise<void> {
  try {
    const item = await withInboxService((svc) => svc.getInbox(id));
    if (!item) {
      console.error(`inbox item not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(formatInboxItem(item));
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      console.error(`Error: ${formatCause(error)}`);
      printHint(error);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Determine if a row is a gate row (G4).
 * Gate rows: kind==='approval' AND have a runId AND context.topic is in GATE_TOPICS.
 * Only gate rows require --approve|--reject and DBOS signal.
 */
function isGateRow(item: InboxItem): boolean {
  if (item.kind !== 'approval') return false;
  if (!item.runId) return false;
  const ctx = item.context as Record<string, unknown> | null;
  if (!ctx || typeof ctx !== 'object') return false;
  const topic = ctx.topic;
  return typeof topic === 'string' && GATE_TOPICS.has(topic);
}

/**
 * InboxResolveDeps — injectable services for `resolveInboxCommand`.
 * Extracted so unit tests can provide fakes without starting NestJS (C4).
 */
export type InboxResolveDeps = {
  getInbox: (id: string) => Promise<InboxItem | null>;
  resolveInbox: (itemId: string, answer: unknown, resolvedBy: string) => Promise<{ status: 'pending' | 'resolved'; answer: unknown }>;
  signal: (workflowId: string, topic: string, payload: unknown, idempotencyKey: string) => Promise<void>;
  completeRun: (
    runId: string,
    opts?: { actor?: string; source?: string; verdict?: string; iterations?: number },
  ) => Promise<unknown>;
  pollRunState: (runId: string, pollOpts?: PollOpts) => Promise<void>;
};

function decisionOf(answer: unknown): string {
  if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)) {
    const decision = (answer as Record<string, unknown>).decision;
    if (typeof decision === 'string') return decision;
  }
  return '';
}

/**
 * resolveGatePath — handle the gate-row branch of inbox resolve (G4).
 * Extracted from resolveInboxCommand to reduce cognitive complexity (S3776).
 *
 * Returns true on success, false on validation error (sets process.exitCode=1).
 */
async function resolveGatePath(
  id: string,
  row: InboxItem,
  options: ResolveOptions,
  deps: InboxResolveDeps,
): Promise<boolean> {
  const resolvedBy = options.by ?? 'cli';

  // Exactly one of --approve/--reject must be present.
  if (options.approve && options.reject) {
    console.error('Error: specify exactly one of --approve or --reject');
    process.exitCode = 1;
    return false;
  }
  if (!options.approve && !options.reject) {
    console.error('Error: specify --approve or --reject for a gate row');
    process.exitCode = 1;
    return false;
  }

  const decision = options.approve
    ? { decision: 'approve' as const, resolvedBy }
    : { decision: 'reject' as const, resolvedBy };

  // resolveInbox returns the STORED decision (G2) — signal WHAT IS RECORDED, not the raw flag.
  const result = await deps.resolveInbox(id, decision, resolvedBy);

  if (result.status === 'resolved') {
    console.log(`note:     already resolved — signaling with stored answer`);
  }

  // Signal the parked workflow with the STORED answer (G2, G9 canonical order: topic before payload).
  // idempotencyKey = inbox id → DBOS.send exactly-once (re-resolve collapses by key).
  const ctx = row.context as Record<string, unknown>;
  const topic = typeof ctx.topic === 'string' ? ctx.topic : '';
  await deps.signal(row.runId, topic, result.answer, id);

  if (topic === 'merge') {
    const decision = decisionOf(result.answer);
    await deps.completeRun(row.runId, {
      actor: 'cli',
      source: decision === 'reject' ? 'merge-gate-reject' : 'merge-gate-approve',
      verdict: '',
      iterations: 0,
    });
  }

  console.log(`resolved  ${id}`);
  console.log(`decision: ${String((result.answer as Record<string, unknown> | null)?.decision ?? result.answer)}`);
  console.log(`by:       ${resolvedBy}`);
  console.log('awaiting next gate or completion…');

  // Poll for next-gate/terminal (same logic as run start, §3.6).
  await deps.pollRunState(row.runId, { wait: options.wait ?? false });
  return true;
}

/**
 * resolveNonGatePath — handle the non-gate-row branch of inbox resolve.
 * Preserved 0002 behavior: table-only resolve, no signal, no host required.
 * Extracted from resolveInboxCommand to reduce cognitive complexity (S3776).
 *
 * Returns true on success, false on validation error (sets process.exitCode=1).
 */
async function resolveNonGatePath(
  id: string,
  options: ResolveOptions,
  deps: InboxResolveDeps,
): Promise<boolean> {
  if (options.approve || options.reject) {
    console.error('Error: --approve/--reject is only valid on a gate row (kind=approval with plan/merge topic)');
    console.error('       for non-gate rows use --answer');
    process.exitCode = 1;
    return false;
  }

  const resolvedBy = options.by ?? 'cli';
  // Normalize: --answer omitted → null (do NOT pass undefined; patch serializer drops it).
  const answer: unknown = options.answer !== undefined ? options.answer : null;

  await deps.resolveInbox(id, answer, resolvedBy);

  console.log(`resolved inbox item ${id}`);
  console.log(`answer: ${JSON.stringify(answer)}`);
  console.log(`resolved by: ${resolvedBy}`);
  return true;
}

/**
 * resolveInboxCommand — testable core of `inbox resolve` (C4).
 * All I/O goes through `deps`; callers provide fakes in tests.
 * Returns `true` on success, `false` on validation / not-found error (sets process.exitCode=1).
 */
export async function resolveInboxCommand(
  id: string,
  options: ResolveOptions,
  deps: InboxResolveDeps,
): Promise<boolean> {
  // (1) Read the row first — needed for both gate and non-gate paths.
  const row = await deps.getInbox(id);
  if (!row) {
    console.error(`inbox item not found: ${id}`);
    process.exitCode = 1;
    return false;
  }

  if (isGateRow(row)) {
    // ── GATE PATH (G4) ────────────────────────────────────────────────────
    // Requires --approve|--reject. Signals the parked DBOS workflow. HOST-REQUIRING.
    return resolveGatePath(id, row, options, deps);
  }

  // ── NON-GATE PATH (0002 preserved) ────────────────────────────────────
  // question/alert/approval-without-topic: table-only resolve, no signal, no host.
  return resolveNonGatePath(id, options, deps);
}

async function inboxResolve(
  id: string,
  options: ResolveOptions,
  app: INestApplicationContext | undefined,
): Promise<void> {
  // Guard: --approve/--reject requires the host context (needsHost enforces this, but be defensive).
  if ((options.approve || options.reject) && !app) {
    console.error('inbox resolve --approve|--reject requires the host context');
    process.exitCode = 1;
    return;
  }

  // Lazily obtain DbosService only if we have a host context (gate path).
  // This avoids importing the engine module on the non-gate path.
  let dbosService: { signal: (w: string, t: string, p: unknown, k: string) => Promise<void>; getWorkflowStatus: (id: string) => Promise<{ status: string } | null> } | null = null;
  if (app) {
    const { DbosService: DbosServiceClass } = await import('../../engine/dbos.service.js');
    dbosService = app.get(DbosServiceClass);
  }

  const deps: InboxResolveDeps = {
    getInbox: (itemId) => withInboxService((svc) => svc.getInbox(itemId)),
    resolveInbox: (itemId, answer, resolvedBy) =>
      withInboxService((svc) => svc.resolveInbox(itemId, answer, resolvedBy)),
    signal: (workflowId, topic, payload, idempotencyKey) => {
      if (!dbosService) throw new Error('signal requires host context');
      return dbosService.signal(workflowId, topic, payload, idempotencyKey);
    },
    completeRun: async (runId, completeOpts) => {
      const { RunService } = await import('../../revisium/run.service.js');
      return withRevisiumService(RunService, (svc) => svc.completeRun(runId, completeOpts));
    },
    pollRunState: (runId, pollOpts) =>
      withInboxService((svc) =>
        pollWorkflowState(runId, dbosService ?? { getWorkflowStatus: async () => null }, svc, pollOpts),
      ),
  };

  try {
    await resolveInboxCommand(id, options, deps);
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      console.error(`Error: ${formatCause(error)}`);
      printHint(error);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

export function registerInbox(program: Command, app?: INestApplicationContext): void {
  const inbox = program.command('inbox').description('Manage the human inbox');

  inbox
    .command('list')
    .description('List inbox items')
    .option('--status <s>', 'Filter by status (pending|resolved)')
    .option('--json', 'Output as JSON', false)
    .action(inboxList);

  inbox
    .command('show')
    .description('Show an inbox item')
    .argument('<id>', 'Inbox item ID')
    .action(inboxShow);

  inbox
    .command('resolve')
    .description('Resolve an inbox item (gate rows require --approve|--reject; non-gate rows use --answer)')
    .argument('<id>', 'Inbox item ID')
    .option('--answer <a>', 'Answer / decision for non-gate rows (omit for null)')
    .option('--approve', 'Approve a gate row (plan/merge)', false)
    .option('--reject', 'Reject a gate row (plan/merge)', false)
    .option('--by <who>', 'Resolver identifier', 'cli')
    .option(
      '--wait',
      'Keep a live viewer attached through step transitions until the run parks at the next gate or finishes',
      false,
    )
    .action((id: string, options: ResolveOptions) => inboxResolve(id, options, app));
}
