/**
 * Pinned DBOS identity for the host daemon.
 *
 * DBOS derives two identifiers from the environment AT IMPORT TIME (dbos-sdk `utils.js` `globalParams`
 * is a module-level literal: `executorID = process.env.DBOS__VMID || 'local'`,
 * `appVersion = process.env.DBOS__APPVERSION || ''`). Left unset, every daemon is `executorID='local'`
 * with a source-MD5 appVersion — indistinguishable in `pg_stat_activity` and brittle across releases.
 * We pin both, so:
 *   - executorID = `revo-<profile>` makes each daemon's DBOS connections self-identifying in
 *     `pg_stat_activity.application_name` (`dbos_transact_<executorID>_<appVersion>`), which is the
 *     ONLY way `revo doctor` can see a rogue/legacy poller that holds no inbound port.
 *   - appVersion = a value WE control, decoupled from the npm release version. DBOS recovery keys on
 *     a HARD `application_version` equality, so a per-release version would strand in-flight PENDING
 *     work on every alpha bump. Pinning a stable workflow version keeps recovery working across a
 *     routine upgrade; it is bumped ONLY when the durable workflow/step SOURCE actually changes.
 *
 * Because `globalParams` is read at import time, the pin must be present in the daemon process's
 * environment from the start — it is applied to the detached child's env in `ensure-host.spawnDaemon`,
 * never mutated after the dbos-sdk module has loaded.
 */

/**
 * Pinned DBOS `appVersion`. NOT the npm package version — bump this ONLY when the durable DBOS
 * workflow/step function SOURCE changes (which moves the recovery/dequeue version boundary). A routine
 * release that does not touch workflow-step code keeps this value so in-flight work recovers cleanly.
 */
export const DBOS_WORKFLOW_VERSION = '1';

/** Stable per-profile DBOS executor id (`revo-<profile>`) — the owner identity the census matches on. */
export function dbosExecutorId(profile: string): string {
  return `revo-${profile}`;
}

/**
 * The `DBOS__VMID` / `DBOS__APPVERSION` env pin for a profile's daemon. An explicitly-SET value in
 * `env` wins (so a custom layout / test can override) — including an explicit empty string, hence `??`
 * not `||`; only an absent (undefined) var falls back to the pinned defaults.
 */
export function dbosEnvPin(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): { DBOS__VMID: string; DBOS__APPVERSION: string } {
  return {
    DBOS__VMID: env['DBOS__VMID'] ?? dbosExecutorId(profile),
    DBOS__APPVERSION: env['DBOS__APPVERSION'] ?? DBOS_WORKFLOW_VERSION,
  };
}
