/**
 * revisium-context.ts — shared Revisium-only Nest context helper for CLI commands.
 *
 * Extracted from run.ts / inbox.ts to eliminate duplication (C4).
 * Lazily imports NestJS and RevisiumModule so the host-free path never loads them.
 * Ensures ctx.close() is called in finally on all paths (edge 10).
 *
 * Usage:
 *   const result = await withRevisiumService(RunService, (svc) => svc.listRuns());
 */
import type { Type } from '@nestjs/common';

/**
 * withRevisiumService — create a per-invocation Revisium-only Nest standalone context,
 * resolve the service identified by `token`, call `fn(svc)`, and always close the context.
 *
 * @param token  - Injectable class token (e.g. RunService, InboxService).
 * @param fn     - Async callback that receives the resolved service instance.
 * @returns        Whatever `fn` returns.
 */
export async function withRevisiumService<S, T>(
  token: Type<S>,
  fn: (svc: S) => Promise<T>,
): Promise<T> {
  const { NestFactory } = await import('@nestjs/core');
  const { RevisiumModule } = await import('../../revisium/revisium.module.js');
  const ctx = await NestFactory.createApplicationContext(RevisiumModule, {
    logger: false,
  });
  try {
    const svc = ctx.get(token);
    return await fn(svc);
  } finally {
    await ctx.close();
  }
}
