import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRolePrompt, stripMarkdownFrontmatter } from './prompt-composer.js';

test('stripMarkdownFrontmatter: removes YAML header when present', () => {
  assert.equal(stripMarkdownFrontmatter('---\nname: x\n---\n# Body\n'), '# Body');
});

test('composeRolePrompt: appends core reference and returns stable hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-prompt-'));
  mkdirSync(join(root, 'roles', 'developer', 'references'), { recursive: true });
  writeFileSync(join(root, 'roles', 'developer', 'ROLE.md'), '---\nname: developer\n---\n# Developer\n');
  writeFileSync(join(root, 'roles', 'developer', 'references', 'core.md'), '# Core\n');

  const prompt = composeRolePrompt(root, {
    id: 'developer',
    path: 'roles/developer/ROLE.md',
    surface: 'any',
    rights: 'write-working-tree',
    defaultModelLevel: 'standard',
    runnerId: 'claude-code',
    wrappers: {},
  });

  assert.equal(prompt.prompt, '# Developer\n\n# Core');
  assert.equal(prompt.sourceHash.length, 64);
});
