/**
 * resolve-cwd.test.ts — B1 contract for resolveRepoCwdFromRef, makeResolveCwd, makeResolveTaskCwd.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoCwdFromRef, makeResolveCwd, makeResolveTaskCwd } from './resolve-cwd.js';
import type { ControlPlaneDataAccess } from './data-access.js';
import type { Step } from './steps.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'resolve-cwd-test-'));
}

function fakeDA(repoRef: string): ControlPlaneDataAccess {
  return {
    assertReady: async () => {},
    getRow: async (_table, rowId) => ({ rowId, data: { repo_ref: repoRef } }),
    listRows: async () => [],
    createRow: async () => ({ rowId: '', data: {} }),
    updateRow: async () => ({ rowId: '', data: {} }),
    patchRow: async () => ({ rowId: '', data: {} }),
  };
}

function missingDA(): ControlPlaneDataAccess {
  return {
    assertReady: async () => {},
    getRow: async () => null,
    listRows: async () => [],
    createRow: async () => ({ rowId: '', data: {} }),
    updateRow: async () => ({ rowId: '', data: {} }),
    patchRow: async () => ({ rowId: '', data: {} }),
  };
}

const FAKE_STEP: Step = {
  id: 's-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'implement',
  status: 'claimed', input: null, output: null, modelProfile: 'standard', runAfter: '',
  attemptCount: 0, maxAttempts: 3, priority: 0, leaseOwner: '', leaseExpiresAt: '', deadReason: '',
};

// ─── resolveRepoCwdFromRef ────────────────────────────────────────────────────

test('resolveRepoCwdFromRef: empty string → base', async () => {
  const base = '/some/base';
  const result = await resolveRepoCwdFromRef('', base);
  assert.equal(result, base);
});

test("resolveRepoCwdFromRef: '.' → base", async () => {
  const base = '/some/base';
  const result = await resolveRepoCwdFromRef('.', base);
  assert.equal(result, base);
});

test('resolveRepoCwdFromRef: absolute existing dir → returned as-is', async () => {
  const dir = makeTmpDir();
  try {
    const result = await resolveRepoCwdFromRef(dir, '/some/unrelated/base');
    assert.equal(result, dir, 'absolute existing dir must be accepted directly');
  } finally {
    rmdirSync(dir);
  }
});

test('resolveRepoCwdFromRef: absolute non-existent path → throws', async () => {
  await assert.rejects(
    () => resolveRepoCwdFromRef('/absolutely/does/not/exist/ever', '/base'),
    /does not exist or is not a directory/,
    'non-existent absolute path must be rejected',
  );
});

test('resolveRepoCwdFromRef: absolute path that is a file → throws', async () => {
  const dir = makeTmpDir();
  const filePath = join(dir, 'afile.txt');
  writeFileSync(filePath, 'content');
  try {
    await assert.rejects(
      () => resolveRepoCwdFromRef(filePath, '/base'),
      /does not exist or is not a directory/,
      'absolute file path must be rejected',
    );
  } finally {
    rmdirSync(dir, { recursive: true } as Parameters<typeof rmdirSync>[1]);
  }
});

test('resolveRepoCwdFromRef: relative path under base that exists → resolved', async () => {
  const base = makeTmpDir();
  const sub = join(base, 'sub');
  // Create sub directory
  const { mkdirSync } = await import('node:fs');
  mkdirSync(sub);
  try {
    const result = await resolveRepoCwdFromRef('sub', base);
    assert.equal(result, sub);
  } finally {
    rmdirSync(base, { recursive: true } as Parameters<typeof rmdirSync>[1]);
  }
});

test("resolveRepoCwdFromRef: relative '../escape' traversal → throws", async () => {
  const base = makeTmpDir();
  try {
    await assert.rejects(
      () => resolveRepoCwdFromRef('../escape', base),
      /escapes the workspace base/,
      'relative traversal must be rejected',
    );
  } finally {
    rmdirSync(base);
  }
});

test('resolveRepoCwdFromRef: relative non-existent under base → throws', async () => {
  const base = makeTmpDir();
  try {
    await assert.rejects(
      () => resolveRepoCwdFromRef('nope-not-here', base),
      /does not exist or is not a directory/,
      'non-existent relative path must be rejected',
    );
  } finally {
    rmdirSync(base);
  }
});

test('resolveRepoCwdFromRef: symlink inside base pointing OUTSIDE → rejected (FIX 2 symlink hardening)', async () => {
  // Create two separate temp dirs: one as the "base" (allowed root) and one as the "outside" target.
  // A symlink inside base points to outside — the lexical check passes but the real check must catch it.
  const base = makeTmpDir();
  const outside = makeTmpDir();
  const linkPath = join(base, 'escape-link');
  let symlinkCreated = false;
  try {
    try {
      symlinkSync(outside, linkPath);
      symlinkCreated = true;
    } catch {
      // Symlink creation not permitted in this environment — skip gracefully.
      return;
    }
    if (!symlinkCreated) return;
    await assert.rejects(
      () => resolveRepoCwdFromRef('escape-link', base),
      /escapes the workspace base/,
      'symlink pointing outside the allowed base must be rejected',
    );
  } finally {
    try { unlinkSync(linkPath); } catch { /* ignore — link may not exist */ }
    rmdirSync(outside);
    rmdirSync(base, { recursive: true } as Parameters<typeof rmdirSync>[1]);
  }
});

// ─── makeResolveCwd (STEP-level) ─────────────────────────────────────────────

test('makeResolveCwd: reads tasks.repo_ref via da and resolves', async () => {
  // Use /tmp which always exists as the absolute ref
  const resolver = makeResolveCwd(fakeDA('/tmp'));
  const result = await resolver(FAKE_STEP);
  assert.equal(result, '/tmp');
});

test('makeResolveCwd: missing task → throws lesson-bearing error', async () => {
  const resolver = makeResolveCwd(missingDA());
  await assert.rejects(
    () => resolver(FAKE_STEP),
    /not found — cannot resolve a working directory/,
  );
});

// ─── makeResolveTaskCwd (TASK-level) ─────────────────────────────────────────

test('makeResolveTaskCwd: reads tasks.repo_ref via da and resolves by taskId', async () => {
  const resolver = makeResolveTaskCwd(fakeDA('/tmp'));
  const result = await resolver('task-1');
  assert.equal(result, '/tmp');
});

test('makeResolveTaskCwd: missing task → throws', async () => {
  const resolver = makeResolveTaskCwd(missingDA());
  await assert.rejects(
    () => resolver('missing-task'),
    /not found — cannot resolve a working directory/,
  );
});
