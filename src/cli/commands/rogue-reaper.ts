









import { isPidWithin } from './process-tree.js';

export type RevoProcKind = 'daemon' | 'mcp';










export function classifyRevoProcess(command: string): RevoProcKind | null {
  const hasEntry =
    /\/bin\/revo(?:\.js)?(?:\s|$)/.test(command) || /\/cli\/index\.(?:ts|js)(?:\s|$)/.test(command);
  if (!hasEntry) return null;
  if (/(?:^|\s)__daemon(?:\s|$)/.test(command)) return 'daemon';
  if (/(?:^|\s)mcp(?:\s|$)/.test(command)) return 'mcp';
  return null;
}

export type RevoProc = { pid: number; command: string; startTime: string | null; kind: RevoProcKind };




export function selectReapTargets(
  procs: ReadonlyArray<RevoProc>,
  protectedPids: ReadonlySet<number>,
  getParent: (pid: number) => number | null,
): RevoProc[] {
  return procs.filter((proc) => !isPidWithin(proc.pid, protectedPids, getParent));
}

export type EvictionOutcome = { converged: boolean; rounds: number; terminated: number };





export async function evictByTermination(
  census: () => Promise<number[]>,
  terminate: (pid: number) => Promise<void>,
  maxRounds = 5,
): Promise<EvictionOutcome> {
  let terminated = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    const rogues = await census();
    if (rogues.length === 0) return { converged: true, rounds: round, terminated };
    for (const pid of rogues) {
      await terminate(pid);
      terminated += 1;
    }
  }
  const remaining = await census();
  return { converged: remaining.length === 0, rounds: maxRounds, terminated };
}
