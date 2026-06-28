/**
 * Pure decision logic for `revo doctor`: turn observed stack state into a pass/fail report with
 * actionable issues. Kept free of IO so the diagnosis rules are unit-tested in isolation;
 * lifecycle.ts does the file/port probing and the printing.
 *
 * `revo doctor` is the LIFECYCLE doctor — it sees the process/port/profile/stale-file problems that
 * the daemon-side control-plane doctor (`api.doctor()`, exposed over MCP/GraphQL) structurally
 * cannot diagnose about itself (a dead daemon answers nothing; a stale runtime file is invisible from
 * inside the process that should have removed it). The two doctors are complementary, not duplicates.
 */

export type TierObservation = {
  /** The tier's runtime file (host.json / runtime.json) exists on disk. */
  present: boolean;
  /** The pid recorded in that file is alive. */
  alive: boolean;
  /** The tier answered its health probe (GraphQL for the host, HTTP for the standalone). */
  healthy: boolean;
  pid: number | null;
  /** Port the health probe targets — only used to make the message actionable. */
  port: number | null;
};

export type DoctorObservation = {
  host: TierObservation;
  standalone: TierObservation;
  /**
   * Processes listening on the profile's ports whose pid does NOT match the tracked daemon/standalone
   * — an untracked or duplicate daemon (the "daemon zoo" signal that lets stale daemons silently serve
   * runs).
   */
  unexpectedPortOwners?: Array<{ label: string; port: number; pid: number }>;
  /** The running daemon's code version differs from this build/installation (stale daemon). */
  versionMismatch?: { running: string; current: string };
  /**
   * Foreign DBOS connections on the profile's `dbos` database whose executor id is not this profile's
   * pinned owner — a legacy/duplicate daemon polling `dev-tasks` that the advisory lock cannot stop and
   * the port-based reap cannot see (it has no inbound listener).
   */
  queuePollerRogues?: Array<{ pid: number; executorId: string; applicationName: string }>;
  /**
   * The rogue-poller census could not run (DB unreachable, or the DB role lacks privilege to see other
   * backends) — so single-ownership could NOT be verified. Reported as a warning, never as "clean".
   */
  rogueCensusUnavailable?: boolean;
};

export type DoctorReport = { ok: boolean; issues: string[] };

export function buildDoctorReport(o: DoctorObservation): DoctorReport {
  const issues: string[] = [];

  // Daemon-zoo signal: a process not tracked by host.json/runtime.json holds a profile port. The
  // advisory-lock singleton stops new duplicates, but pre-existing/orphan ones must be seen.
  for (const owner of o.unexpectedPortOwners ?? []) {
    issues.push(
      `Unexpected process (pid ${owner.pid}) on the ${owner.label} port ${owner.port} — an untracked or ` +
        'duplicate daemon. Run `revo stop` to reap the profile, then `revo start`.',
    );
  }

  // Stale-code daemon: the live daemon is a different build than this CLI/installation.
  if (o.versionMismatch && o.versionMismatch.running !== o.versionMismatch.current) {
    issues.push(
      `Running daemon is version ${o.versionMismatch.running} but this build is ${o.versionMismatch.current} — ` +
        'run `revo restart` to replace the stale daemon.',
    );
  }

  // Rogue queue pollers: a legacy/duplicate daemon connected to the dbos DB under a foreign executor id.
  // The advisory lock can't coordinate it and port-based stop can't see it; reap the stale process.
  const rogues = o.queuePollerRogues ?? [];
  if (rogues.length > 0) {
    const byExecutor = new Map<string, number[]>();
    for (const r of rogues) byExecutor.set(r.executorId, [...(byExecutor.get(r.executorId) ?? []), r.pid]);
    for (const [executorId, pids] of byExecutor) {
      issues.push(
        `DBOS queue database has ${pids.length} connection(s) from a foreign executor "${executorId}" ` +
          `(backend pid${pids.length === 1 ? '' : 's'} ${pids.join(', ')}) — a stale/duplicate daemon polling ` +
          'dev-tasks. The advisory lock cannot evict an outbound poller; reap the stale revo process ' +
          '(`pkill -f "revo mcp"` / `pkill -f "revo __daemon"`), then `revo restart`.',
      );
    }
  } else if (o.rogueCensusUnavailable) {
    issues.push(
      'Could not census the DBOS queue database for duplicate pollers (DB unreachable or insufficient ' +
        'privilege) — single-ownership could not be verified.',
    );
  }

  // Nothing recorded on either tier → the stack is simply down (unless a rogue process was flagged above).
  if (!o.host.present && !o.standalone.present) {
    if (issues.length === 0) return { ok: false, issues: ['Stack is not running. Run `revo start`.'] };
    return { ok: false, issues };
  }

  // Host tier — the single DBOS owner and the GraphQL/MCP front door.
  if (o.host.present && !o.host.alive) {
    issues.push(
      `Stale host.json: recorded pid ${o.host.pid} is not alive. Run \`revo stop\` to clear it, then \`revo start\`.`,
    );
  } else if (o.host.alive && !o.host.healthy) {
    issues.push(
      `Host daemon (pid ${o.host.pid}) is running but its GraphQL front door on port ${o.host.port} is not responding.`,
    );
  } else if (!o.host.present && o.standalone.alive) {
    issues.push('Host daemon is not running while the standalone daemon is — the stack is partial. Run `revo start`.');
  }

  // Standalone tier — the Revisium control plane and its embedded Postgres.
  if (o.standalone.present && !o.standalone.alive) {
    issues.push(`Stale runtime.json: recorded standalone pid ${o.standalone.pid} is not alive.`);
  } else if (o.standalone.alive && !o.standalone.healthy) {
    issues.push(
      `Standalone Revisium (pid ${o.standalone.pid}) is running but unhealthy on port ${o.standalone.port}.`,
    );
  } else if (!o.standalone.present && o.host.alive) {
    issues.push(
      'Standalone Revisium is not running while the host daemon is — the stack is partial. Run `revo restart`.',
    );
  }

  return { ok: issues.length === 0, issues };
}
