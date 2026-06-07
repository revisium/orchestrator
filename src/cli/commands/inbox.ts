/**
 * inbox.ts — CLI commands for managing the human inbox.
 *
 * Routes through InboxService obtained from a per-invocation Revisium-only Nest context
 * (Option A, §3.0). NestJS is lazily imported so the host-free path never loads it.
 * inbox stays host-free — NOT added to HOST_COMMANDS, needsHost() unchanged.
 *
 * NOTE: `revo inbox resolve` in 0002 is a TABLE-ONLY resolve: status flip + step
 * continuation (no DBOS signal). The DBOS send/recv gate-wiring is slice 0004.
 *
 * Invariant #4: no @revisium/client import in this file (verbs only).
 */
import { Command } from 'commander';
import { ControlPlaneError } from '../../control-plane/index.js';
import type { InboxService } from '../../revisium/inbox.service.js';
import type { InboxItem } from '../../control-plane/inbox.js';
import { withRevisiumService } from './revisium-context.js';

type ListOptions = {
  status?: string;
  json: boolean;
};

type ResolveOptions = {
  answer?: string;
  by?: string;
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

async function inboxResolve(id: string, options: ResolveOptions): Promise<void> {
  try {
    // Normalize: --answer omitted → null (do NOT pass undefined; patch serializer drops it).
    const answer: unknown = options.answer !== undefined ? options.answer : null;
    const resolvedBy = options.by ?? 'cli';

    await withInboxService((svc) => svc.resolveInbox(id, answer, resolvedBy));

    console.log(`resolved inbox item ${id}`);
    console.log(`answer: ${JSON.stringify(answer)}`);
    console.log(`resolved by: ${resolvedBy}`);
    console.log('(table-only resolve in 0002; DBOS signal deferred to slice 0004)');
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

export function registerInbox(program: Command): void {
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
    .description('Resolve an inbox item (table-only in 0002; DBOS signal is slice 0004)')
    .argument('<id>', 'Inbox item ID')
    .option('--answer <a>', 'Answer / decision (omit for null)')
    .option('--by <who>', 'Resolver identifier', 'cli')
    .action(inboxResolve);
}
