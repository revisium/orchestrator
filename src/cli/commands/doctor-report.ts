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
};

export type DoctorReport = { ok: boolean; issues: string[] };

export function buildDoctorReport(o: DoctorObservation): DoctorReport {
  // Nothing recorded on either tier → the stack is simply down, not broken.
  if (!o.host.present && !o.standalone.present) {
    return { ok: false, issues: ['Stack is not running. Run `revo start`.'] };
  }

  const issues: string[] = [];

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
