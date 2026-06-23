/**
 * Host daemon entrypoint — the long-lived Revo/NestJS process and the SINGLE DBOS owner (ADR 0006).
 *
 * Boot order matters for control-plane visibility:
 *   1. ensureRevisium — standalone (storage) up first.
 *   2. bootstrapControlPlane + seed default playbook — ALL control-plane writes happen here, through
 *      fresh `@revisium/client` scopes that commit to HEAD, BEFORE the service layer exists. The
 *      services (PlaybooksService.head, GraphQL readers) cache their read scope on first use; running
 *      every write first means they cache an ALREADY-POPULATED head — otherwise same-boot reads see a
 *      stale empty head until a restart (a fresh client resolves head per call, a cached scope does not).
 *   3. startGraphqlHost — boots Nest (HostLifecycle re-ensures Revisium = no-op, ensures Postgres,
 *      DBOS.launch — recovery once) and serves GraphQL + WS.
 *   4. host.json — written LAST; its presence is the "fully ready" signal ensureHost waits on, so a
 *      client never observes a not-yet-bootstrapped stack.
 *
 * SIGTERM/SIGINT closes the Nest app (→ DBOS.shutdown via HostLifecycle.onApplicationShutdown) and
 * clears only its own host.json (compare-and-delete). Spawned detached by ensureHost; never built on
 * the per-command CLI path (that path is removed — nothing else launches DBOS).
 */
import { getConfig } from '../config.js';
import { startGraphqlHost } from '../http/graphql-host.js';
import { ensureRevisium } from './ensure-revisium.js';
import { bootstrapControlPlane, listInstalledPlaybooks } from '../control-plane/bootstrap.js';
import {
  createDaemonInstaller,
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../control-plane/seed-default-playbook.js';
import { removeHostRuntimeIfMatches, writeHostRuntime } from './host-runtime.js';

export async function runHostDaemon(): Promise<void> {
  // 1. Standalone up first, then 2. all control-plane writes via fresh client scopes — BEFORE the
  // service layer (startGraphqlHost) caches its read scope, so same-boot reads see a ready control-plane.
  const { runtime } = await ensureRevisium();
  await bootstrapControlPlane(runtime.httpPort);
  await seedDefaultPlaybookBestEffort(() =>
    seedDefaultPlaybook(createDaemonInstaller(() => listInstalledPlaybooks(runtime.httpPort))),
  );

  // 3. Now bring up the Nest/GraphQL/DBOS layer (HostLifecycle re-ensures Revisium = no-op).
  const started = await startGraphqlHost();

  const startedAt = new Date().toISOString();
  const snapshot = { pid: process.pid, startedAt };

  // 4. Ready signal — written last.
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
