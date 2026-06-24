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
 *   4. McpHttpService — the MCP front door (StreamableHTTP) that `revo mcp` bridges to.
 *   5. host.json — written LAST; its presence is the "fully ready" signal ensureHost waits on, so a
 *      client never observes a not-yet-bootstrapped stack.
 *
 * SIGTERM/SIGINT closes the Nest app (→ DBOS.shutdown via HostLifecycle.onApplicationShutdown) and
 * the MCP server, and clears only its own host.json (compare-and-delete). Spawned detached by
 * ensureHost; never built on the per-command CLI path (that path is removed — nothing else launches DBOS).
 */
import { type Server as HttpServer } from 'node:http';
import { getConfig } from '../config.js';
import { startGraphqlHost } from '../http/graphql-host.js';
import { ensureRevisium } from './ensure-revisium.js';
import { bootstrapControlPlane, listInstalledPlaybooks } from '../control-plane/bootstrap.js';
import {
  createDaemonInstaller,
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../control-plane/seed-default-playbook.js';
import { McpFacadeService } from '../mcp/mcp-facade.service.js';
import { McpHttpService } from '../mcp/mcp-http.service.js';
import { RunWatchService, type WatchPubSub } from '../task-control-plane/run-watch.service.js';
import { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';
import { APP_PUB_SUB } from '../api/graphql-api/graphql-ws/constants.js';
import { hostCodeVersion, removeHostRuntimeIfMatches, writeHostRuntime } from './host-runtime.js';
import { acquireQueueOwnership } from './queue-ownership.js';

/** MCP endpoint port: REVO_MCP_PORT, else the GraphQL port + 1 (kept in the profile band). */
function resolveMcpPort(graphqlPort: number): number {
  const env = process.env['REVO_MCP_PORT'];
  return env && /^\d+$/.test(env.trim()) ? Number(env.trim()) : graphqlPort + 1;
}

/** The detached host-daemon entrypoint (spawned by ensureHost): boot the stack, then serve + stay alive. */
export async function runHostDaemon(): Promise<void> {
  // 1. Standalone up first, then 2. all control-plane writes via fresh client scopes — BEFORE the
  // service layer (startGraphqlHost) caches its read scope, so same-boot reads see a ready control-plane.
  const { runtime } = await ensureRevisium();

  // Singleton gate (slice 139): exactly ONE host daemon per profile may own + poll the dev-tasks
  // queue. Acquired here — BEFORE DBOS.launch()/queue polling (startGraphqlHost) — so a daemon that
  // lost a concurrent cold-start race exits cleanly without ever touching the queue; ensureHost then
  // attaches to the winner via host.json. Crash-safe: the connection-scoped advisory lock frees itself
  // if this process dies.
  const ownership = await acquireQueueOwnership(getConfig().profile, runtime.pgPort);
  if (!ownership.owned) {
    console.error(
      `[host] profile "${getConfig().profile}" is already owned by another daemon — exiting; the owner serves the queue.`,
    );
    process.exit(0);
  }

  await bootstrapControlPlane(runtime.httpPort);
  await seedDefaultPlaybookBestEffort(() =>
    seedDefaultPlaybook(createDaemonInstaller(() => listInstalledPlaybooks(runtime.httpPort))),
  );

  // 3. Now bring up the Nest/GraphQL/DBOS layer (HostLifecycle re-ensures Revisium = no-op).
  const started = await startGraphqlHost();

  // 4. MCP front door + 5. host.json. Wrapped so a failure AFTER startGraphqlHost (DBOS already
  // launched) never leaves a live DBOS owner without host.json: on error we close the MCP server +
  // Nest app (→ DBOS.shutdown) and exit non-zero, so ensureHost reports the failure, not a zombie.
  let mcpServer: HttpServer | undefined;
  try {
    // Build the MCP facade from the DI-resolved TaskControlPlaneApiService (the surface the GraphQL
    // resolvers use): resolving McpFacadeService itself via app.get left its injected `api` undefined.
    const mcpPort = resolveMcpPort(started.port);
    const api = started.app.get(TaskControlPlaneApiService, { strict: false });
    // Option A (slice 141 D2): give the watch primitive APP_PUB_SUB so a gate/terminal wakes a held
    // long-poll instead of polling. PubSubModule is @Global, so it resolves off the started handle; if
    // it can't, RunWatchService degrades to its internal poll (option B) — same correctness.
    let watchPubSub: WatchPubSub | undefined;
    try {
      watchPubSub = started.app.get<WatchPubSub>(APP_PUB_SUB, { strict: false });
    } catch {
      watchPubSub = undefined;
    }
    const runWatch = new RunWatchService(api, watchPubSub);
    mcpServer = await new McpHttpService(new McpFacadeService(api, runWatch)).start(mcpPort);

    const startedAt = new Date().toISOString();
    const snapshot = { pid: process.pid, startedAt };

    // host.json is written LAST — its presence is the "fully ready" signal ensureHost waits on.
    writeHostRuntime({
      pid: process.pid,
      graphqlPort: started.port,
      mcpPort,
      startedAt,
      profile: getConfig().profile,
      version: hostCodeVersion(),
    });

    const runningMcp = mcpServer;
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      runningMcp.close();
      started.app
        .close() // → HostLifecycle.onApplicationShutdown → DBOS.shutdown()
        .catch(() => undefined)
        .finally(() => {
          ownership
            .release() // free the dev-tasks ownership lock for the next daemon
            .catch(() => undefined)
            .finally(() => {
              removeHostRuntimeIfMatches(snapshot);
              process.exit(0);
            });
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    mcpServer?.close();
    await started.app.close().catch(() => undefined);
    await ownership.release().catch(() => undefined);
    throw err;
  }
}
