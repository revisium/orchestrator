













import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  worktreePathFor,
  worktreeMarkerFor,
  isWorktreeDir,
} from '../control-plane/resolve-cwd.js';
import { resolveExecutable } from '../runners/integrator.js';


export type WorktreeExecGit = (args: string[], cwd: string) => string;

const GIT_TIMEOUT_MS = 60_000;

let _gitAbsPath: string | undefined;
function gitAbsPath(): string {
  if (_gitAbsPath === undefined) _gitAbsPath = resolveExecutable('git');
  return _gitAbsPath;
}


function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync(gitAbsPath(), args, { encoding: 'utf8', cwd, timeout: GIT_TIMEOUT_MS });
}

const INSTALL_TIMEOUT_MS = 300_000;


export type WorktreeExecInstall = (args: string[], cwd: string) => void;

function defaultExecInstall(args: string[], cwd: string): void {
  execFileSync(resolveExecutable('pnpm'), args, { cwd, timeout: INSTALL_TIMEOUT_MS, stdio: 'ignore' });
}









function provisionDeps(worktreePath: string, baseRepoCwd: string, execInstall: WorktreeExecInstall): void {
  if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) {
    try {
      execInstall(['install', '--frozen-lockfile'], worktreePath);
      return;
    } catch {
    }
  }
  try {
    const baseModules = join(baseRepoCwd, 'node_modules');
    const wtModules = join(worktreePath, 'node_modules');
    if (existsSync(baseModules) && !existsSync(wtModules)) {
      symlinkSync(baseModules, wtModules, 'dir');
    }
  } catch {
  }
}

export type CreateRunWorktreeOpts = {
  runId: string;

  baseRepoCwd: string;

  base: string;

  branch: string;
  dataDir: string;
  execGit?: WorktreeExecGit;
  execInstall?: WorktreeExecInstall;
};










export function createRunWorktree(opts: CreateRunWorktreeOpts): { worktreePath: string } {
  const { runId, baseRepoCwd, base, branch, dataDir } = opts;
  const execGit = opts.execGit ?? defaultExecGit;
  const execInstall = opts.execInstall ?? defaultExecInstall;
  const worktreePath = worktreePathFor(dataDir, runId);

  if (isWorktreeDir(worktreePath)) {
    writeMarker(dataDir, runId);
    return { worktreePath };
  }

  mkdirSync(dirname(worktreePath), { recursive: true });
  execGit(['fetch', 'origin', base], baseRepoCwd);
  execGit(['worktree', 'add', '-B', branch, worktreePath, `origin/${base}`], baseRepoCwd);

  provisionDeps(worktreePath, baseRepoCwd, execInstall);

  writeMarker(dataDir, runId);
  return { worktreePath };
}

export type ReleaseRunWorktreeResult =
  | { released: true }
  | { released: false; reason: 'absent' | 'dirty' };

export type ReleaseRunWorktreeOpts = {
  runId: string;

  baseRepoCwd: string;
  dataDir: string;
  execGit?: WorktreeExecGit;
  force?: boolean;
};





export function releaseRunWorktree(opts: ReleaseRunWorktreeOpts): ReleaseRunWorktreeResult {
  const { runId, baseRepoCwd, dataDir, force = false } = opts;
  const execGit = opts.execGit ?? defaultExecGit;
  const worktreePath = worktreePathFor(dataDir, runId);

  if (!existsSync(worktreePath)) {
    try { execGit(['worktree', 'prune'], baseRepoCwd); } catch { }
    return { released: false, reason: 'absent' };
  }

  if (!force) {
    try {
      const status = execGit(['status', '--porcelain'], worktreePath);
      if (status.trim().length > 0) {
        return { released: false, reason: 'dirty' };
      }
    } catch { }
  }

  try {
    execGit(['worktree', 'remove', '--force', worktreePath], baseRepoCwd);
  } catch {
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  } catch {
  }
  try {
    execGit(['worktree', 'prune'], baseRepoCwd);
  } catch {
  }
  try {
    rmSync(worktreeMarkerFor(dataDir, runId), { force: true });
  } catch {
  }
  return { released: true };
}

function writeMarker(dataDir: string, runId: string): void {
  writeFileSync(worktreeMarkerFor(dataDir, runId), `${runId}\n`, 'utf8');
}
