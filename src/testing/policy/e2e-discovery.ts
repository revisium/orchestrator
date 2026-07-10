import { readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultE2eRoot = resolve(repositoryRoot, 'src/e2e');

export function discoverE2eTests(root = defaultE2eRoot): string[] {
  const discovered: string[] = [];
  const physicalFiles = new Set<string>();

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.e2e.test.ts')) continue;

      const physicalPath = realpathSync(path);
      if (physicalFiles.has(physicalPath)) {
        throw new Error(`E2E test discovered more than once: ${relative(repositoryRoot, path)}`);
      }
      physicalFiles.add(physicalPath);
      discovered.push(relative(repositoryRoot, path).split(sep).join('/'));
    }
  }

  visit(root);
  return discovered.sort((left, right) => left.localeCompare(right));
}
