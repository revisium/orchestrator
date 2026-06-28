














const STAMP_PREFIX = 'dbos_transact_';

export type PollerBackend = {

  pid: number;

  applicationName: string;

  backendStart?: unknown;
};

export type RoguePoller = {
  pid: number;

  executorId: string;
  applicationName: string;
  backendStart?: unknown;
};






export function parseExecutorId(applicationName: string): string | null {
  if (!applicationName.startsWith(STAMP_PREFIX)) return null;
  const rest = applicationName.slice(STAMP_PREFIX.length);
  const sep = rest.lastIndexOf('_');
  const executorId = sep < 0 ? rest : rest.slice(0, sep);
  return executorId.length > 0 ? executorId : null;
}



export function classifyQueuePollerRogues(
  backends: ReadonlyArray<PollerBackend>,
  ownerExecutorId: string,
): RoguePoller[] {
  const rogues: RoguePoller[] = [];
  for (const b of backends) {
    const executorId = parseExecutorId(b.applicationName);
    if (executorId === null || executorId === ownerExecutorId) continue;
    rogues.push({ pid: b.pid, executorId, applicationName: b.applicationName, backendStart: b.backendStart });
  }
  return rogues;
}
