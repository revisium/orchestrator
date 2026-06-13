import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import os from 'node:os';
import { PlaybookError } from './errors.js';

export type PlaybookSourceType = 'local' | 'package';

export type ResolvedPlaybookSource = {
  type: PlaybookSourceType;
  input: string;
  root: string;
  source: string;
  packageName: string;
  version: string;
};

export type SourceResolverOptions = {
  cwd?: string;
  packageRootResolver?: (specifier: string) => string;
};

const requireFromHere = createRequire(import.meta.url);

function expandHome(path: string): string {
  if (path === '~') return os.homedir();
  if (path.startsWith('~/')) return join(os.homedir(), path.slice(2));
  return path;
}

function defaultPackageRootResolver(specifier: string): string {
  return dirname(requireFromHere.resolve(`${specifier}/package.json`));
}

function readPackageMetadata(root: string): { name: string; version: string } {
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) return { name: '', version: '' };
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown; version?: unknown };
  return {
    name: typeof parsed.name === 'string' ? parsed.name : '',
    version: typeof parsed.version === 'string' ? parsed.version : '',
  };
}

function looksLikeRemoteSource(source: string): boolean {
  return (
    source.startsWith('github:') ||
    source.startsWith('git+') ||
    source.startsWith('https://') ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)
  );
}

function localSourceIdentity(input: string, pkg: { name: string; version: string }): string {
  if (pkg.name) {
    const versionSuffix = pkg.version ? `@${pkg.version}` : '';
    return `local:${pkg.name}${versionSuffix}`;
  }
  return `local:${input}`;
}

function packageSourceIdentity(input: string, version: string): string {
  const versionSuffix = version ? `@${version}` : '';
  return `npm:${input}${versionSuffix}`;
}

function looksLikePath(source: string): boolean {
  return source.startsWith('.') || source.startsWith('/') || source.startsWith('~');
}

export function assertPathInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new PlaybookError('PLAYBOOK_INVALID_PATH', `Path escapes playbook root: ${target}`, { root, target });
}

export function resolvePathInside(root: string, relativePath: string): string {
  if (relativePath === '' || isAbsolute(relativePath)) {
    throw new PlaybookError('PLAYBOOK_INVALID_PATH', `Path must be relative inside playbook root: ${relativePath}`, {
      root,
      relativePath,
    });
  }
  const target = resolve(root, relativePath);
  assertPathInside(root, target);
  return target;
}

export function resolvePlaybookSource(
  input: string,
  options: SourceResolverOptions = {},
): ResolvedPlaybookSource {
  const cwd = options.cwd ?? process.cwd();
  const packageRootResolver = options.packageRootResolver ?? defaultPackageRootResolver;
  const localCandidate = resolve(cwd, expandHome(input));

  if (looksLikePath(input) || (existsSync(localCandidate) && statSync(localCandidate).isDirectory())) {
    const root = localCandidate;
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new PlaybookError('PLAYBOOK_SOURCE_NOT_FOUND', `Playbook source directory not found: ${input}`, { input });
    }
    const pkg = readPackageMetadata(root);
    return {
      type: 'local',
      input,
      root,
      source: localSourceIdentity(input, pkg),
      packageName: pkg.name,
      version: pkg.version,
    };
  }

  if (looksLikeRemoteSource(input) && !input.startsWith('@')) {
    throw new PlaybookError(
      'PLAYBOOK_SOURCE_NOT_IMPLEMENTED',
      `Remote playbook sources are not implemented in this slice: ${input}`,
      { input },
    );
  }

  try {
    const root = packageRootResolver(input);
    const pkg = readPackageMetadata(root);
    return {
      type: 'package',
      input,
      root,
      source: packageSourceIdentity(input, pkg.version),
      packageName: pkg.name || input,
      version: pkg.version,
    };
  } catch (error) {
    throw new PlaybookError('PLAYBOOK_SOURCE_NOT_FOUND', `Playbook package not found: ${input}`, {
      input,
      error,
    });
  }
}
