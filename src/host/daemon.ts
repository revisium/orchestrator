/**
 * Host daemon entrypoint — the long-lived Revo/NestJS process and the SINGLE DBOS owner (ADR 0006).
 *
 * Reuses startGraphqlHost, which already runs the full host boot via HostLifecycle (ensureRevisium →
 * ensurePostgres → DBOS.launch — recovery happens here, once) and serves GraphQL + WS. This process
 * then records its identity in `host.json` so `ensureHost`/`status`/`stop` can find and manage it,
 * and stays alive on the listening socket. SIGTERM/SIGINT closes the Nest app (→ DBOS.shutdown via
 * HostLifecycle.onApplicationShutdown) and clears only its own `host.json` (compare-and-delete).
 *
 * Spawned detached by `ensureHost`; never built on the per-command CLI path (that path is removed —
 * nothing else launches DBOS).
 */
import { getConfig } from '../config.js';
import { startGraphqlHost } from '../http/graphql-host.js';
import { removeHostRuntimeIfMatches, writeHostRuntime } from './host-runtime.js';

export async function runHostDaemon(): Promise<void> {
  const started = await startGraphqlHost();
  const startedAt = new Date().toISOString();
  const snapshot = { pid: process.pid, startedAt };

  writeHostRuntime({
    pid: process.pid,
    graphqlPort: started.port,
    startedAt,
    profile: getConfig().profile,
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    started.app
      .close() // → HostLifecycle.onApplicationShutdown → DBOS.shutdown()
      .catch(() => undefined)
      .finally(() => {
        removeHostRuntimeIfMatches(snapshot);
        process.exit(0);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
