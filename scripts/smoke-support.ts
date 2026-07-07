import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EngineApiService } from '@revisium/engine';
import { bootstrapEngineControlPlane } from '../src/control-plane/bootstrap.js';
import { closeControlPlaneNotificationPool } from '../src/control-plane/change-notifications.js';
import { createControlPlaneDataAccessForTransport } from '../src/control-plane/data-access.js';
import {
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../src/control-plane/seed-default-playbook.js';
import { DbosService } from '../src/engine/dbos.service.js';
import { RevisiumModule } from '../src/revisium/revisium.module.js';
import { PlaybooksService } from '../src/revisium/playbooks.service.js';
import {
  REVISIUM_TRANSPORT_DRAFT,
  REVISIUM_TRANSPORT_HEAD,
} from '../src/revisium/tokens.js';
import { RevoPrismaService } from '../src/storage/revo-prisma.service.js';
import {
  ensureStorage,
  shutdownStorage,
} from '../src/storage/ensure-storage.js';
import { TaskControlPlaneApiService } from '../src/task-control-plane/task-control-plane-api.service.js';
import { TaskControlPlaneModule } from '../src/task-control-plane/task-control-plane.module.js';

async function bootstrapContext(ctx: INestApplicationContext): Promise<void> {
  const engine = ctx.get(EngineApiService, { strict: false });
  const prisma = ctx.get(RevoPrismaService, { strict: false });
  const playbooks = ctx.get(PlaybooksService, { strict: false });
  await bootstrapEngineControlPlane(engine, prisma);
  await seedDefaultPlaybookBestEffort(() => seedDefaultPlaybook(playbooks));
}

async function closeSmokeRuntime(ctx: INestApplicationContext): Promise<void> {
  let closeError: unknown;
  await ctx.close().catch((error: unknown) => {
    closeError = error;
  });
  await closeControlPlaneNotificationPool().catch(() => undefined);
  await shutdownStorage().catch(() => undefined);
  if (closeError) throw closeError;
}

export async function createSmokeDataAccess() {
  await ensureStorage();
  const ctx = await NestFactory.createApplicationContext(RevisiumModule, {
    logger: ['error', 'warn'],
  });
  try {
    await bootstrapContext(ctx);
    return {
      ctx,
      draft: createControlPlaneDataAccessForTransport(
        ctx.get(REVISIUM_TRANSPORT_DRAFT, { strict: false }),
      ),
      head: createControlPlaneDataAccessForTransport(
        ctx.get(REVISIUM_TRANSPORT_HEAD, { strict: false }),
      ),
      close: async () => {
        await closeSmokeRuntime(ctx);
      },
    };
  } catch (error) {
    await ctx.close().catch(() => undefined);
    await closeControlPlaneNotificationPool().catch(() => undefined);
    await shutdownStorage().catch(() => undefined);
    throw error;
  }
}

export async function createSmokeApi() {
  await ensureStorage();
  const ctx = await NestFactory.createApplicationContext(
    TaskControlPlaneModule,
    { logger: ['error', 'warn'] },
  );
  let dbos: DbosService | undefined;
  try {
    await bootstrapContext(ctx);
    dbos = ctx.get(DbosService, { strict: false });
    const storage = await ensureStorage();
    dbos.setConfig(storage.dbosDatabaseUrl, { logLevel: 'warn' });
    await dbos.launch();
    return {
      ctx,
      api: ctx.get(TaskControlPlaneApiService, { strict: false }),
      dbos,
      draft: createControlPlaneDataAccessForTransport(
        ctx.get(REVISIUM_TRANSPORT_DRAFT, { strict: false }),
      ),
      head: createControlPlaneDataAccessForTransport(
        ctx.get(REVISIUM_TRANSPORT_HEAD, { strict: false }),
      ),
      close: async () => {
        await dbos.shutdown().catch(() => undefined);
        await closeSmokeRuntime(ctx);
      },
    };
  } catch (error) {
    await dbos?.shutdown().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await closeControlPlaneNotificationPool().catch(() => undefined);
    await shutdownStorage().catch(() => undefined);
    throw error;
  }
}
