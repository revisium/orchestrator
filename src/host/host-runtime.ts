







import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, isAlive, profileDataDir, PROFILES, type ProfileName } from '../config.js';

export type HostRuntimeState = {
  pid: number;
  graphqlPort: number;

  mcpPort: number;
  startedAt: string;
  profile: string;

  version?: string;
};

let cachedCodeVersion: string | undefined;




export function hostCodeVersion(): string {
  if (cachedCodeVersion === undefined) {
    try {
      const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      cachedCodeVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
      cachedCodeVersion = 'unknown';
    }
  }
  return cachedCodeVersion;
}


export type HostRuntimeSnapshot = Pick<HostRuntimeState, 'pid' | 'startedAt'>;

export function hostRuntimeFile(): string {
  return join(getConfig().dataDir, 'host.json');
}

export function readHostRuntime(): HostRuntimeState | null {
  return readHostRuntimeAt(hostRuntimeFile());
}


export function readHostRuntimeAt(file: string): HostRuntimeState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HostRuntimeState;
  } catch {
    return null;
  }
}





export function allTrackedHostPids(): number[] {
  const pids: number[] = [];
  for (const profile of Object.keys(PROFILES) as ProfileName[]) {
    const runtime = readHostRuntimeAt(join(profileDataDir(profile), 'host.json'));
    if (runtime && isAlive(runtime.pid)) pids.push(runtime.pid);
  }
  return pids;
}

export function writeHostRuntime(state: HostRuntimeState): void {
  writeFileSync(hostRuntimeFile(), JSON.stringify(state, null, 2));
}

export function removeHostRuntime(): void {
  const file = hostRuntimeFile();
  if (existsSync(file)) rmSync(file);
}




export function removeHostRuntimeIfMatches(snapshot: HostRuntimeSnapshot): void {
  const current = readHostRuntime();
  if (current?.pid === snapshot.pid && current?.startedAt === snapshot.startedAt) {
    removeHostRuntime();
  }
}


export function isHostRunning(): boolean {
  const runtime = readHostRuntime();
  return runtime !== null && isAlive(runtime.pid);
}
