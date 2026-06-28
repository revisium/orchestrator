

















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


function resolveMcpPort(graphqlPort: number): number {
  const env = process.env['REVO_MCP_PORT'];
  return env && /^\d+$/.test(env.trim()) ? Number(env.trim()) : graphqlPort + 1;
}


export async function runHostDaemon(): Promise<void> {
  const { runtime } = await ensureRevisium();

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

  const started = await startGraphqlHost();

  let mcpServer: HttpServer | undefined;
  try {
    const mcpPort = resolveMcpPort(started.port);
    const api = started.app.get(TaskControlPlaneApiService, { strict: false });
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
        .close()
        .catch(() => undefined)
        .finally(() => {
          ownership
            .release()
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
