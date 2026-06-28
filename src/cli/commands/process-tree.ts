




import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const PS_PATH = ['/bin/ps', '/usr/bin/ps'].find((p) => existsSync(p)) ?? null;


export function listProcesses(): Array<{ pid: number; command: string }> {
  if (PS_PATH === null) return [];
  try {
    const out = execFileSync(PS_PATH, ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
    const procs: Array<{ pid: number; command: string }> = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), command: m[2] });
    }
    return procs;
  } catch {
    return [];
  }
}


export function parentPid(pid: number): number | null {
  if (PS_PATH === null) return null;
  try {
    const out = execFileSync(PS_PATH, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}





export function processStartTime(pid: number): string | null {
  if (PS_PATH === null) return null;
  try {
    const out = execFileSync(PS_PATH, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}




export function isPidWithin(
  pid: number,
  ancestors: ReadonlySet<number>,
  getParent: (p: number) => number | null = parentPid,
  maxHops = 32,
): boolean {
  let current: number | null = pid;
  for (let hops = 0; current !== null && hops <= maxHops; hops += 1) {
    if (ancestors.has(current)) return true;
    if (current <= 1) return false;
    current = getParent(current);
  }
  return false;
}
