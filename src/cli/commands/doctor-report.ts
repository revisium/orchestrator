








export type TierObservation = {

  present: boolean;

  alive: boolean;

  healthy: boolean;
  pid: number | null;

  port: number | null;
};

export type DoctorObservation = {
  host: TierObservation;
  standalone: TierObservation;



  unexpectedPortOwners?: Array<{ label: string; port: number; pid: number }>;

  versionMismatch?: { running: string; current: string };



  queuePollerRogues?: Array<{ pid: number; executorId: string; applicationName: string }>;


  rogueCensusUnavailable?: boolean;
};

export type DoctorReport = { ok: boolean; issues: string[] };

export function buildDoctorReport(o: DoctorObservation): DoctorReport {
  const issues: string[] = [];

  for (const owner of o.unexpectedPortOwners ?? []) {
    issues.push(
      `Unexpected process (pid ${owner.pid}) on the ${owner.label} port ${owner.port} — an untracked or ` +
        'duplicate daemon. Run `revo stop` to reap the profile, then `revo start`.',
    );
  }

  if (o.versionMismatch && o.versionMismatch.running !== o.versionMismatch.current) {
    issues.push(
      `Running daemon is version ${o.versionMismatch.running} but this build is ${o.versionMismatch.current} — ` +
        'run `revo restart` to replace the stale daemon.',
    );
  }

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

  if (!o.host.present && !o.standalone.present) {
    if (issues.length === 0) return { ok: false, issues: ['Stack is not running. Run `revo start`.'] };
    return { ok: false, issues };
  }

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
