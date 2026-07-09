














import { execFileSync } from 'node:child_process';
import type { ExecGhFn } from '../poller/pr-readiness.js';


export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { encoding: 'utf8'; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => string;

const defaultExecFile: ExecFileFn = (file, args, opts) => execFileSync(file, args, opts);



export function resolveGhAccount(input: {
  account?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileFn;
} = {}): string | undefined {
  const explicit = input.account?.trim();
  if (explicit) return explicit;

  const env = input.env ?? process.env;
  const envAccount = env['REVO_GH_ACCOUNT']?.trim();
  if (envAccount) return envAccount;

  const execFile = input.execFile ?? defaultExecFile;
  try {
    const out = execFile('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}


export function ghTokenEnvKey(account: string): string {
  return `GH_TOKEN_${account.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}





export function resolveGhToken(
  account: string,
  deps?: { env?: NodeJS.ProcessEnv; execFile?: ExecFileFn },
): string | undefined {
  const env = deps?.env ?? process.env;
  const execFile = deps?.execFile ?? defaultExecFile;

  const override = env[ghTokenEnvKey(account)];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();

  try {
    const out = execFile('gh', ['auth', 'token', '--user', account], {
      encoding: 'utf8',
      timeout: 15_000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}





export function makeExecGh(opts?: {
  token?: string;
  execFile?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}): ExecGhFn {
  const execFile = opts?.execFile ?? defaultExecFile;
  const baseEnv = opts?.env ?? process.env;
  const timeout = opts?.timeoutMs ?? 60_000;
  const maxBuffer = opts?.maxBuffer ?? 10 * 1024 * 1024;
  const env = opts?.token ? { ...baseEnv, GH_TOKEN: opts.token } : baseEnv;
  return (args: string[]) => execFile('gh', args, { encoding: 'utf8', timeout, maxBuffer, env });
}


export type PinnedGhResult = { account: string; execGh: ExecGhFn } | { needsHuman: true; lesson: string };










export function resolvePinnedGh(deps?: { account?: string; env?: NodeJS.ProcessEnv; execFile?: ExecFileFn }): PinnedGhResult {
  const env = deps?.env ?? process.env;
  const account = resolveGhAccount({ account: deps?.account, env, execFile: deps?.execFile });
  if (!account) {
    return {
      needsHuman: true,
      lesson:
        'could not resolve a gh account from the run profile, REVO_GH_ACCOUNT, or active gh auth — REFUSING to ' +
        'fall back to an ambient or hardcoded account. Fix: set accounts.github in the run profile, set ' +
        'REVO_GH_ACCOUNT, or authenticate gh on this host.',
    };
  }
  const token = resolveGhToken(account, { env, execFile: deps?.execFile });
  if (!token) {
    return {
      needsHuman: true,
      lesson:
        `could not resolve a token for the pinned gh account '${account}' — REFUSING to fall back to the ambient ` +
        `gh account (0008 #1: a PR must never be opened by the wrong account). Fix: set ${ghTokenEnvKey(account)} in ` +
        `the host env (keyring-free, works headless), or run on a host where 'gh auth token --user ${account}' can ` +
        `reach the keychain.`,
    };
  }
  return { account, execGh: makeExecGh({ token, env, execFile: deps?.execFile }) };
}

const TOKEN_PATTERN = /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;




export function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, '[REDACTED]');
}
