

















import { type Server as HttpServer } from 'node:http';
import { EngineApiService } from '@revisium/engine';
import { getConfig } from '../config.js';
import { bootstrapEngineControlPlane } from '../control-plane/bootstrap.js';
import {
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../control-plane/seed-default-playbook.js';
import { startGraphqlHost } from '../http/graphql-host.js';
import { McpFacadeService } from '../mcp/mcp-facade.service.js';
import { McpHttpService } from '../mcp/mcp-http.service.js';
import { PlaybooksService } from '../revisium/playbooks.service.js';
import { RevoPrismaService } from '../storage/revo-prisma.service.js';
import { ensureStorage, shutdownStorage } from '../storage/ensure-storage.js';
import { RunWatchService, type WatchPubSub } from '../task-control-plane/run-watch.service.js';
import { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';
import { APP_PUB_SUB } from '../api/graphql-api/graphql-ws/constants.js';
import { hostCodeVersion, removeHostRuntimeIfMatches, writeHostRuntime } from './host-runtime.js';
import { acquireQueueOwnership } from './queue-ownership.js';


function resolveMcpPort(graphqlPort: number): number {
  const env = process.env['REVO_MCP_PORT'];
  return env && /^\d+$/.test(env.trim()) ? Number(env.trim()) : graphqlPort + 1;
}

function isKnownDbosShutdownNoise(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Release called on client which has already been released to the pool');
}


export async function runHostDaemon(): Promise<void> {
  const storage = await ensureStorage();

  const ownership = await acquireQueueOwnership(getConfig().profile, storage.pgPort);
  if (!ownership.owned) {
    console.error(
      `[host] profile "${getConfig().profile}" is already owned by another daemon — exiting; the owner serves the queue.`,
    );
    process.exit(0);
  }

  const started = await startGraphqlHost({
    beforeListen: async (app) => {
      const engine = app.get(EngineApiService, { strict: false });
      const prisma = app.get(RevoPrismaService, { strict: false });
      await bootstrapEngineControlPlane(engine, prisma);
      const playbooks = app.get(PlaybooksService, { strict: false });
      await seedDefaultPlaybookBestEffort(() =>
        seedDefaultPlaybook({
          listPlaybooks: () => playbooks.listPlaybooks(),
          install: (options) => playbooks.install(options),
        }),
      );
    },
  });

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
      pgPort: storage.pgPort,
      startedAt,
      profile: getConfig().profile,
      version: hostCodeVersion(),
    });

    const runningMcp = mcpServer;
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      process.once('uncaughtException', (error) => {
        if (isKnownDbosShutdownNoise(error)) {
          process.exit(0);
        }
        console.error(error);
        process.exit(1);
      });
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
    await shutdownStorage().catch(() => undefined);
    throw err;
  }
}
