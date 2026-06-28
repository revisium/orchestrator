/**
 * Queue-poller census (detection half, pure).
 *
 * The advisory lock (queue-ownership.ts) only coordinates daemons that CALL it. A legacy/old-version
 * host that predates the lock — or a `revo mcp` from before the thin-bridge era that is itself a full
 * DBOS host — still connects to the `dbos` database and polls the `dev-tasks` queue, ignoring the lock.
 * It has no inbound listening port, so the port-based `revo stop`/`doctor` cannot see it. The ONE
 * control plane shared with code we do not control is the database itself: every DBOS system-DB
 * connection is stamped `application_name = dbos_transact_<executorID>_<appVersion>` (visible in
 * `pg_stat_activity`). A connection whose executor id is NOT this profile's pinned owner is a rogue.
 *
 * This module is the pure classifier (unit-tested); the live `pg_stat_activity` query lives in the IO
 * layer (lifecycle.ts). Classification keys on the executor-id segment ONLY: `application_name` is
 * capped at 63 bytes by Postgres, so a long suffix can truncate the appVersion — we therefore never
 * trust the parsed version for identity (the owner's true version comes from host.json elsewhere).
 */

const STAMP_PREFIX = 'dbos_transact_';

export type PollerBackend = {
  /** Server-side Postgres backend pid (NOT the client/daemon process pid). */
  pid: number;
  /** `pg_stat_activity.application_name`. */
  applicationName: string;
  /** `pg_stat_activity.backend_start`, if read — for display only. */
  backendStart?: unknown;
};

export type RoguePoller = {
  pid: number;
  /** Parsed executor id of the foreign connection (e.g. `local` for an unpinned legacy host). */
  executorId: string;
  applicationName: string;
  backendStart?: unknown;
};

/**
 * Parse the executor id out of `dbos_transact_<executorID>_<appVersion>` — the segment between the
 * fixed prefix and the LAST underscore (the appVersion separator). Returns null when the string is not
 * a DBOS stamp. Robust to a truncated/empty appVersion segment (we only need the executor id); pinned
 * revo executor ids (`revo-<profile>`) and `local` contain no underscore, so the last-underscore split
 * is unambiguous for the identities we classify.
 */
export function parseExecutorId(applicationName: string): string | null {
  if (!applicationName.startsWith(STAMP_PREFIX)) return null;
  const rest = applicationName.slice(STAMP_PREFIX.length); // <executorID>_<appVersion>
  const sep = rest.lastIndexOf('_');
  const executorId = sep < 0 ? rest : rest.slice(0, sep);
  return executorId.length > 0 ? executorId : null;
}

/**
 * Foreign DBOS pollers among `backends` — any connection whose parsed executor id differs from the
 * profile's pinned owner. Report-only data; the caller decides how to surface or evict it.
 */
export function classifyQueuePollerRogues(
  backends: ReadonlyArray<PollerBackend>,
  ownerExecutorId: string,
): RoguePoller[] {
  const rogues: RoguePoller[] = [];
  for (const b of backends) {
    const executorId = parseExecutorId(b.applicationName);
    if (executorId === null || executorId === ownerExecutorId) continue;
    rogues.push({ pid: b.pid, executorId, applicationName: b.applicationName, backendStart: b.backendStart });
  }
  return rogues;
}
