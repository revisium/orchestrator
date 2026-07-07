import { existsSync, readFileSync } from 'node:fs';
import { isAlive } from '../config.js';

export function tailLines(path: string, lines: number): string {
  if (!existsSync(path)) return '';
  const all = readFileSync(path, 'utf8').split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.slice(-lines).join('\n');
}

export function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
    }
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !isAlive(pid);
}
