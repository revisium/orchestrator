import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';

type Api = TaskControlPlaneApiService;
export type PersistedRunDetail = Awaited<ReturnType<Api['getRun']>>;
export type PersistedRunEvent = Awaited<ReturnType<Api['getRunEvents']>>[number];

export async function waitForRunDetail(
  api: Api,
  runId: string,
  accept: (detail: PersistedRunDetail) => boolean,
  timeoutMs = 5_000,
): Promise<PersistedRunDetail> {
  let detail = await api.getRun({ runId });
  for (let waited = 0; waited < timeoutMs && !accept(detail); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    detail = await api.getRun({ runId });
  }
  return detail;
}

export async function waitForRunEvents(
  api: Api,
  runId: string,
  accept: (events: readonly PersistedRunEvent[]) => boolean,
  options: Readonly<{ timeoutMs?: number; intervalMs?: number; limit?: number }> = {},
): Promise<readonly PersistedRunEvent[]> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const intervalMs = options.intervalMs ?? 250;
  const limit = options.limit ?? 500;
  let events = await api.getRunEvents({ runId, limit });
  for (let waited = 0; waited < timeoutMs && !accept(events); waited += intervalMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    events = await api.getRunEvents({ runId, limit });
  }
  return events;
}

export function readRunEvents(
  api: Api,
  runId: string,
  limit = 500,
): Promise<readonly PersistedRunEvent[]> {
  return api.getRunEvents({ runId, limit });
}

export function readRunAttempts(api: Api, runId: string) {
  return api.getRunLog({ runId, limit: 50 });
}

export function readRunDigest(api: Api, runId: string) {
  return api.getRunDigest(runId);
}
