/**
 * integrator.test.ts — unit tests for integrator.ts (B1/B3/B4/B5/M4/OQ-2).
 *
 * Uses fake execGit / execGh fns — no real git, no real gh, no network.
 * Tests STUB, REAL integrator logic, preflightLive, find-or-create PR, replay safety.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  integrate,
  stubIntegrate,
  preflightLive,
  resolveExecutable,
  parseOwnerRepo,
  type IntegratorInput,
  type IntegratorDeps,
  type ExecFn,
} from './integrator.js';
import type { ExecGhFn } from '../poller/pr-readiness.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function neverGit(_args: string[], _cwd: string): string {
  throw new Error('execGit must not be called');
}

function neverGh(_args: string[]): string {
  throw new Error('execGh must not be called');
}

const FAKE_CWD = '/fake/repo';

function makeResolveTaskCwd(cwd = FAKE_CWD): (taskId: string) => Promise<string> {
  return async () => cwd;
}

const BASE_INPUT: IntegratorInput = {
  runId: 'run-001',
  taskId: 'task-001',
  title: 'Add feature X',
  base: 'master',
};

// ─── STUB (B3 — zero external effects) ────────────────────────────────────────

test('B3: stubIntegrate returns placeholder with no execGit/execGh calls', () => {
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];

  // Wrap to detect if called
  const trackingGit: ExecFn = (args, cwd) => {
    gitCalls.push(args);
    return neverGit(args, cwd);
  };
  const trackingGh: ExecGhFn = (args) => {
    ghCalls.push(args);
    return neverGh(args);
  };
  void trackingGit; void trackingGh; // not passed to stubIntegrate

  const result = stubIntegrate(BASE_INPUT);

  assert.equal(result.prUrl, 'stub://pr/placeholder');
  assert.equal(result.prNumber, 0);
  assert.ok(result.branch.startsWith('feat/'), 'branch must start with feat/');
  assert.equal(gitCalls.length, 0, 'execGit must NOT be called in stub');
  assert.equal(ghCalls.length, 0, 'execGh must NOT be called in stub');
});

// ─── preflightLive (B5) ───────────────────────────────────────────────────────

test('preflightLive: clean + on correct base → { ok: true }', async () => {
  const headSha = 'abc123def456';
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'master\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return headSha + '\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return headSha + '\n';
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('ok' in result && result.ok === true, 'clean repo on fresh master → ok');
});

test('preflightLive: dirty repo → needsHuman (not clean)', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return 'M src/foo.ts\n';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'dirty repo must block with needsHuman');
  assert.ok(
    result.lesson.includes('not clean') || result.lesson.includes('uncommitted'),
    `lesson must mention dirty state: ${result.lesson}`,
  );
});

test('preflightLive: clean but HEAD on wrong branch → needsHuman (base mismatch)', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature-branch\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'bbb222\n';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'wrong branch must block');
  assert.ok(result.lesson.includes('not on a fresh origin/master'), `lesson: ${result.lesson}`);
});

test('preflightLive: clean but HEAD sha differs from origin/master → needsHuman', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'master\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'bbb222\n';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'behind origin/master must block');
});

test('preflightLive: fetch failure → needsHuman (no-base lesson)', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') throw new Error('fatal: branch not found');
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'fetch failure must return needsHuman');
  assert.ok(result.lesson.includes('fetch'), `lesson must mention fetch: ${result.lesson}`);
});

// ─── owner/repo derivation (OQ-2) ─────────────────────────────────────────────

test('integrate: git@github.com SSH remote → parses owner/repo', async () => {
  const capturedGhArgs: string[][] = [];
  const headSha = 'abc123';

  // Simulate a clean repo on master, branch already exists with commit ahead
  const calls: string[] = [];
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      calls.push(args[0] ?? '');
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:owner/repo.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found'); // branch absent
      if (args[0] === 'switch' && args[1] === '-c') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') {
        // diff --cached --quiet → exit 1 = staged diff present
        if (args.includes('--cached') && args.includes('--quiet')) throw new Error('exit 1');
        throw new Error(`unexpected diff: ${args.join(' ')}`);
      }
      if (args[0] === 'commit') return `[feat/${headSha}] feat: Add feature X`;
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      capturedGhArgs.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/repo/pull/1\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/owner/repo/pull/1', number: 1 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok(!('needsHuman' in result), `integrate must succeed, got: ${JSON.stringify(result)}`);
  if (!('needsHuman' in result)) {
    assert.ok(result.prUrl.includes('github.com/owner/repo'), `prUrl must contain owner/repo: ${result.prUrl}`);
  }

  // Verify gh was called with 'owner/repo' repo
  const listCall = capturedGhArgs.find((a) => a[1] === 'list');
  assert.ok(listCall, 'gh pr list must be called');
  const repoIdx = listCall?.indexOf('--repo');
  assert.ok(repoIdx !== undefined && repoIdx >= 0);
  assert.equal(listCall?.[repoIdx + 1], 'owner/repo');
});

test('integrate: https GitHub remote → parses owner/repo', async () => {
  let capturedRepo = '';
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'https://github.com/owner2/repo2\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: (args) => {
      const repoIdx = args.indexOf('--repo');
      if (repoIdx >= 0) capturedRepo = args[repoIdx + 1] ?? '';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner2/repo2/pull/2\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/owner2/repo2/pull/2', number: 2 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  await integrate(BASE_INPUT, deps);
  assert.equal(capturedRepo, 'owner2/repo2');
});

test('integrate: missing/unparseable remote → { needsHuman }', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote') throw new Error('fatal: not a git repo');
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok('needsHuman' in result, 'missing remote must return needsHuman');
  assert.ok(result.lesson.includes('no parseable github remote'), `lesson: ${result.lesson}`);
});

// ─── REAL — find-or-create PR (M4) ───────────────────────────────────────────

test('M4: gh pr list returns existing PR → reuse url, no pr create called', async () => {
  let createCalled = false;
  const existingPr = [{ number: 42, url: 'https://github.com/o/r/pull/42', baseRefName: 'master' }];

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(existingPr);
      if (args[0] === 'pr' && args[1] === 'create') {
        createCalled = true;
        return 'https://github.com/o/r/pull/new\n';
      }
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok(!('needsHuman' in result));
  if (!('needsHuman' in result)) {
    assert.equal(result.prUrl, 'https://github.com/o/r/pull/42', 'must reuse existing PR url');
    assert.equal(result.prNumber, 42);
  }
  assert.equal(createCalled, false, 'pr create must NOT be called when PR already exists');
});

test('M4: gh pr list returns 0 → creates PR', async () => {
  let createCalled = false;

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') {
        createCalled = true;
        return 'https://github.com/o/r/pull/7\n';
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/o/r/pull/7', number: 7 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok(!('needsHuman' in result));
  assert.equal(createCalled, true, 'pr create must be called when no PR exists');
  if (!('needsHuman' in result)) {
    assert.equal(result.prNumber, 7);
  }
});

test('M4: >1 matching PR → { needsHuman } naming candidates, no duplicate create', async () => {
  let createCalled = false;
  const ambiguous = [
    { number: 5, url: 'https://github.com/o/r/pull/5', baseRefName: 'master' },
    { number: 6, url: 'https://github.com/o/r/pull/6', baseRefName: 'master' },
  ];

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(ambiguous);
      if (args[0] === 'pr' && args[1] === 'create') {
        createCalled = true;
        return 'url\n';
      }
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok('needsHuman' in result, 'ambiguous PRs must return needsHuman');
  assert.ok(result.lesson.includes('5') && result.lesson.includes('6'), `lesson must name candidates: ${result.lesson}`);
  assert.equal(createCalled, false, 'pr create must NOT be called when ambiguous');
});

// ─── REAL — replay safety (B4) ───────────────────────────────────────────────

test('B4 replay: branch exists + index clean + ahead → push + PR (no second commit)', async () => {
  let commitCalled = false;
  let pushCalled = false;

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123\n'; // branch exists
      if (args[0] === 'switch' && args[1] !== '-c') return ''; // switch to existing branch
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) return ''; // exit 0 → no staged diff
      if (args[0] === 'rev-list' && args.includes('--count')) return '3\n'; // 3 commits ahead
      if (args[0] === 'commit') {
        commitCalled = true;
        return '';
      }
      if (args[0] === 'push') {
        pushCalled = true;
        return '';
      }
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/9\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/o/r/pull/9', number: 9 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok(!('needsHuman' in result), `must succeed: ${JSON.stringify(result)}`);
  assert.equal(commitCalled, false, 'commit must NOT be called when no staged diff (replay after commit)');
  assert.equal(pushCalled, true, 'push MUST be called when branch is ahead');
});

test('B4 replay: branch exists + index clean + NOT ahead → { needsHuman: nothing to integrate }', async () => {
  let pushCalled = false;

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123\n'; // branch exists
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) return ''; // no staged diff
      if (args[0] === 'rev-list' && args.includes('--count')) return '0\n'; // NOT ahead
      if (args[0] === 'push') { pushCalled = true; return ''; }
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok('needsHuman' in result, 'nothing to integrate must return needsHuman');
  assert.ok(result.lesson.includes('nothing to integrate'), `lesson: ${result.lesson}`);
  assert.equal(pushCalled, false, 'push must NOT be called when nothing to integrate');
});

test('B4 replay: existing PR found on replay → same url, no duplicate create', async () => {
  let createCalled = false;
  const existingPr = [{ number: 42, url: 'https://github.com/o/r/pull/42', baseRefName: 'master' }];

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123\n';
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) return ''; // no staged diff
      if (args[0] === 'rev-list' && args.includes('--count')) return '1\n'; // ahead — replay
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(existingPr);
      if (args[0] === 'pr' && args[1] === 'create') { createCalled = true; return 'url'; }
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok(!('needsHuman' in result));
  if (!('needsHuman' in result)) {
    assert.equal(result.prUrl, 'https://github.com/o/r/pull/42', 'must return same PR url on replay');
  }
  assert.equal(createCalled, false, 'must NOT create duplicate PR on replay');
});

// ─── commit message (no co-author, no summary) ────────────────────────────────

test('commit message: no Co-Authored-By, no summary footer', async () => {
  let commitMsg = '';

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit' && args[1] === '-m') {
        commitMsg = args[2] ?? '';
        return '';
      }
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/1\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/o/r/pull/1', number: 1 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  await integrate(BASE_INPUT, deps);
  assert.ok(!commitMsg.includes('Co-Authored-By'), 'commit message must not contain Co-Authored-By');
  assert.ok(!commitMsg.toLowerCase().includes('summary'), 'commit message must not contain summary footer');
});

// ─── m1: non-JSON from gh pr view after create → needsHuman (no stub://) ─────

test('m1: gh pr view returns non-JSON after create → needsHuman (never stub://)', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/99\n';
      // pr view returns non-JSON (simulates a gh CLI glitch)
      if (args[0] === 'pr' && args[1] === 'view') return 'not-json-output';
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok('needsHuman' in result, 'non-JSON pr view must return needsHuman, not stub://');
  assert.ok(
    !result.lesson.includes('stub://'),
    `lesson must NOT contain stub://: ${result.lesson}`,
  );
  assert.ok(
    result.lesson.includes('non-JSON') || result.lesson.includes('pr view'),
    `lesson must mention the non-JSON condition: ${result.lesson}`,
  );
});

// ─── m3: dotted repo names in SSH/HTTPS remotes ────────────────────────────────

test('m3: SSH remote with dotted repo name (my.repo) → parsed correctly', () => {
  // parseOwnerRepo is not exported, test via the integrate path by checking execGh --repo arg.
  // Use a fresh integrate call with a remote that has a dot in the repo name.
  const capturedGhArgs: string[][] = [];

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:owner/my.repo.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      capturedGhArgs.push(args);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/my.repo/pull/1\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/owner/my.repo/pull/1', number: 1 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  return integrate(BASE_INPUT, deps).then((result) => {
    assert.ok(!('needsHuman' in result), `dotted repo must parse: ${JSON.stringify(result)}`);
    const listCall = capturedGhArgs.find((a) => a[1] === 'list');
    const repoIdx = listCall?.indexOf('--repo') ?? -1;
    assert.ok(repoIdx >= 0, 'gh pr list must be called with --repo');
    assert.equal(listCall?.[repoIdx + 1], 'owner/my.repo', 'dotted repo name must be parsed correctly');
  });
});

test('m3: HTTPS remote with dotted repo name → parsed correctly', () => {
  const capturedRepo: string[] = [];

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'https://github.com/owner2/api.service.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      const repoIdx = args.indexOf('--repo');
      if (repoIdx >= 0) capturedRepo.push(args[repoIdx + 1] ?? '');
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner2/api.service/pull/1\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/owner2/api.service/pull/1', number: 1 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  return integrate(BASE_INPUT, deps).then((result) => {
    assert.ok(!('needsHuman' in result), `dotted HTTPS repo must parse: ${JSON.stringify(result)}`);
    assert.ok(capturedRepo.some((r) => r === 'owner2/api.service'), `expected owner2/api.service, got: ${JSON.stringify(capturedRepo)}`);
  });
});

// ─── m4: countAhead only swallows expected errors, rethrows transient ones ─────

test('m4: countAhead swallows unknown-revision error (branch not yet known) → returns 0', async () => {
  // When rev-list fails with "unknown revision", branch is not ahead → returns 0 (not a transient error).
  let pushCalled = false;

  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123\n'; // branch exists
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) return ''; // no staged diff
      if (args[0] === 'rev-list' && args.includes('--count')) {
        throw new Error('fatal: ambiguous argument \'origin/master..feat/t\': unknown revision');
      }
      if (args[0] === 'push') { pushCalled = true; return ''; }
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  const result = await integrate(BASE_INPUT, deps);
  assert.ok('needsHuman' in result, 'unknown-revision in countAhead → nothing to integrate');
  assert.ok(result.lesson.includes('nothing to integrate'), `lesson: ${result.lesson}`);
  assert.equal(pushCalled, false, 'push must NOT be called when countAhead returns 0');
});

test('m4: countAhead rethrows transient errors (lock file, OOM) for DBOS retry', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123\n';
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) return '';
      if (args[0] === 'rev-list' && args.includes('--count')) {
        throw new Error('error: cannot lock ref: resource busy');
      }
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  await assert.rejects(
    () => integrate(BASE_INPUT, deps),
    /cannot lock ref|resource busy/,
    'transient git error in countAhead must propagate for DBOS retry',
  );
});

// ─── regex hardening: owner/repo validation (m2) ──────────────────────────────
//
// parseOwnerRepo is internal; tested via a minimal integrate() path where
// the only output of interest is whether the remote parses (ok) or rejects
// (needsHuman). The helper below calls integrate with a fake that returns
// the given remote string and fails immediately on any git call after that,
// so only parseOwnerRepo's output determines the result.

function makeRemoteOnlyDeps(remoteUrl: string): IntegratorDeps {
  return {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return remoteUrl + '\n';
      // Returning here allows integrate to proceed past resolveOwnerRepo.
      // For negative cases, resolveOwnerRepo returns needsHuman before fetch.
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected git: ${args.join(' ')}`);
    },
    execGh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/1\n';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ url: 'https://github.com/o/r/pull/1', number: 1 });
      throw new Error(`unexpected gh: ${args.join(' ')}`);
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };
}

// Positive cases — must parse successfully.
test('regex: SSH plain owner/repo → accepted', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('git@github.com:o/repo'));
  assert.ok(!('needsHuman' in result), `plain SSH must parse: ${JSON.stringify(result)}`);
});

test('regex: SSH owner/repo.git → stripped, accepted', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('git@github.com:o/repo.git'));
  assert.ok(!('needsHuman' in result), `SSH .git must be stripped: ${JSON.stringify(result)}`);
});

test('regex: SSH owner/my.repo → dotted repo accepted', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('git@github.com:o/my.repo'));
  assert.ok(!('needsHuman' in result), `dotted SSH repo must parse: ${JSON.stringify(result)}`);
});

test('regex: HTTPS owner/repo → accepted', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('https://github.com/o/repo'));
  assert.ok(!('needsHuman' in result), `plain HTTPS must parse: ${JSON.stringify(result)}`);
});

test('regex: HTTPS owner/my.repo.git → stripped, accepted', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('https://github.com/o/my.repo.git'));
  assert.ok(!('needsHuman' in result), `HTTPS dotted .git must be stripped: ${JSON.stringify(result)}`);
});

// Negative cases — must reject with needsHuman.
test('regex: SSH with space in repo name → rejected', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('git@github.com:o/re po.git'));
  assert.ok('needsHuman' in result, 'space in SSH repo name must reject');
});

test('regex: HTTPS with space in repo name → rejected', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('https://github.com/o/re po.git'));
  assert.ok('needsHuman' in result, 'space in HTTPS repo name must reject');
});

test('regex: HTTPS trailing /issues path → rejected', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('https://github.com/o/my.repo/issues'));
  assert.ok('needsHuman' in result, 'trailing /issues path must reject');
});

test('regex: HTTPS trailing /tree/main path → rejected', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('https://github.com/o/repo/tree/main'));
  assert.ok('needsHuman' in result, 'trailing /tree/main path must reject');
});

test('regex: HTTPS missing repo segment → rejected', async () => {
  const result = await integrate(BASE_INPUT, makeRemoteOnlyDeps('https://github.com/o/'));
  assert.ok('needsHuman' in result, 'missing repo segment must reject');
});

// ─── errors propagate (transient git/gh errors → throw for DBOS retry) ─────────

test('transient gh error (non-not-found) → throws for DBOS retry', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'remote' && args[2] === 'origin') return 'git@github.com:o/r.git\n';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not found');
      if (args[0] === 'switch') return '';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) throw new Error('staged');
      if (args[0] === 'commit') return '';
      if (args[0] === 'push') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: (_args) => {
      throw new Error('rate limit exceeded');
    },
    resolveTaskCwd: makeResolveTaskCwd(),
  };

  await assert.rejects(
    () => integrate(BASE_INPUT, deps),
    /rate limit exceeded/,
    'transient gh error must propagate (not swallowed)',
  );
});

// ─── resolveExecutable ────────────────────────────────────────────────────────

test('resolveExecutable: finds "node" on real PATH → returns absolute path', () => {
  // node itself must be on PATH since we are running inside node
  const resolved = resolveExecutable('node');
  assert.ok(path.isAbsolute(resolved), `must be absolute, got: ${resolved}`);
  assert.ok(resolved.includes('node'), `path must include "node": ${resolved}`);
});

test('resolveExecutable: injected PATH with a real directory → returns file in that dir', () => {
  // Use the directory of the node binary; node is guaranteed to live there.
  const nodeBin = process.execPath; // absolute path to current node binary
  const nodeDir = path.dirname(nodeBin);
  const nodeName = path.basename(nodeBin);
  // Strip any version suffix so we match the bare name (e.g. "node" not "node24")
  const baseName = nodeName.replace(/\d.*$/, '') || nodeName;

  // Inject just that one directory
  const resolved = resolveExecutable(baseName, nodeDir);
  assert.ok(path.isAbsolute(resolved), `must be absolute: ${resolved}`);
  assert.equal(path.dirname(resolved), nodeDir, 'resolved dir must match injected dir');
});

test('resolveExecutable: executable not found → throws with clear message', () => {
  assert.throws(
    () => resolveExecutable('__no_such_executable_xyz__', '/tmp'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('cannot resolve executable'),
        `message must mention resolution failure: ${err.message}`,
      );
      assert.ok(
        err.message.includes('__no_such_executable_xyz__'),
        `message must name the executable: ${err.message}`,
      );
      return true;
    },
  );
});

test('resolveExecutable: empty PATH → throws with clear message', () => {
  assert.throws(
    () => resolveExecutable('git', ''),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('cannot resolve executable'),
        `message must mention resolution failure: ${err.message}`,
      );
      return true;
    },
  );
});

test('resolveExecutable: PATH with empty segments → skipped gracefully', () => {
  // PATH with empty entries (e.g. ":/bin") — empty segment must be skipped without throwing.
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const nodeName = path.basename(nodeBin).replace(/\d.*$/, '') || path.basename(nodeBin);
  // Prepend two empty segments to test robustness
  const paddedPath = `${path.delimiter}${path.delimiter}${nodeDir}`;
  const resolved = resolveExecutable(nodeName, paddedPath);
  assert.ok(path.isAbsolute(resolved), `must still resolve with empty PATH segments: ${resolved}`);
});

// ─── parseOwnerRepo ───────────────────────────────────────────────────────────

test('parseOwnerRepo: SSH plain → owner/repo', () => {
  assert.equal(parseOwnerRepo('git@github.com:o/repo'), 'o/repo');
});

test('parseOwnerRepo: SSH .git suffix stripped', () => {
  assert.equal(parseOwnerRepo('git@github.com:o/repo.git'), 'o/repo');
});

test('parseOwnerRepo: SSH dotted repo name preserved', () => {
  assert.equal(parseOwnerRepo('git@github.com:o/my.repo'), 'o/my.repo');
});

test('parseOwnerRepo: SSH dashed/underscored/dotted owner and repo', () => {
  assert.equal(parseOwnerRepo('git@github.com:my-org/my_repo.js'), 'my-org/my_repo.js');
});

test('parseOwnerRepo: HTTPS plain → owner/repo', () => {
  assert.equal(parseOwnerRepo('https://github.com/o/repo'), 'o/repo');
});

test('parseOwnerRepo: HTTPS dotted repo .git suffix stripped', () => {
  assert.equal(parseOwnerRepo('https://github.com/o/my.repo.git'), 'o/my.repo');
});

test('parseOwnerRepo: HTTP (non-TLS) accepted', () => {
  assert.equal(parseOwnerRepo('http://github.com/o/repo'), 'o/repo');
});

test('parseOwnerRepo: leading/trailing whitespace trimmed', () => {
  assert.equal(parseOwnerRepo('  git@github.com:o/repo\n'), 'o/repo');
});

test('parseOwnerRepo: empty string → null', () => {
  assert.equal(parseOwnerRepo(''), null);
});

test('parseOwnerRepo: space inside repo segment → null', () => {
  assert.equal(parseOwnerRepo('git@github.com:o/re po.git'), null);
});

test('parseOwnerRepo: HTTPS missing repo segment → null', () => {
  assert.equal(parseOwnerRepo('https://github.com/o/'), null);
});

test('parseOwnerRepo: HTTPS trailing path after repo → null', () => {
  assert.equal(parseOwnerRepo('https://github.com/o/repo/tree/main'), null);
});

test('parseOwnerRepo: non-github host → null', () => {
  assert.equal(parseOwnerRepo('https://gitlab.com/o/repo'), null);
});

test('parseOwnerRepo: bare owner/repo (no scheme/host) → null', () => {
  assert.equal(parseOwnerRepo('o/repo'), null);
});
