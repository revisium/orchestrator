import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverE2eTests } from '../src/testing/policy/e2e-discovery.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${discoverE2eTests().join('\n')}\n`);
}
