import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let tsxCliPath: string | undefined;

type SpawnCli = typeof spawn;

export type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

export type RunCliDeps = {
  spawn?: SpawnCli;
  tsxCliPath?: string;
};

function resolveTsxCliPath(): string {
  if (tsxCliPath) return tsxCliPath;
  const require = createRequire(import.meta.url);
  const tsxPackagePath = require.resolve('tsx/package.json');
  const tsxPackage = require(tsxPackagePath) as { bin: string | Record<string, string> };
  const tsxBin = typeof tsxPackage.bin === 'string' ? tsxPackage.bin : tsxPackage.bin.tsx;
  if (!tsxBin) throw new Error('Could not resolve tsx CLI path from package.json');
  tsxCliPath = join(dirname(tsxPackagePath), tsxBin);
  return tsxCliPath;
}

export function runCli(args: string[], deps: RunCliDeps = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const spawnCli = deps.spawn ?? spawn;
    const child = spawnCli(process.execPath, [deps.tsxCliPath ?? resolveTsxCliPath(), 'src/cli/index.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

export function matchId(output: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(output);
  if (!match?.[1]) throw new Error(`Could not parse ${label} from CLI output:\n${output}`);
  return match[1];
}

export function assertIncludes(str: string, sub: string, label: string): void {
  if (!str.includes(sub)) throw new Error(`${label}: expected output to include "${sub}".\nGot:\n${str}`);
}
