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
  confirmMerge,
  stubIntegrate,
  preflightLive,
  pollPr,
  respondThreads,
  resolveExecutable,
  parseOwnerRepo,
  type IntegratorInput,
  type IntegratorDeps,
  type PollPrDeps,
  type PollPrReadiness,
  type Triage,
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

// plan 0017: integrate() resolves cwd by runId via resolveRunCwd. In these unit tests the worktree is
// the same FAKE_CWD (the test's real git repo) — they exercise integrate's git logic, not isolation.
function makeResolveRunCwd(cwd = FAKE_CWD): (runId: string, taskId: string) => Promise<string> {
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'dirty repo must block with needsHuman');
  assert.ok(
    result.lesson.includes('not clean') || result.lesson.includes('uncommitted'),
    `lesson must mention dirty state: ${result.lesson}`,
  );
});

test('preflightLive: clean feature branch based on origin/base → { ok: true }', async () => {
  const calls: string[] = [];
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      calls.push(args.join(' '));
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature-branch\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'bbb222\n';
      if (
        args[0] === 'merge-base' &&
        args[1] === '--is-ancestor' &&
        args[2] === 'origin/master' &&
        args[3] === 'HEAD'
      ) {
        return '';
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('ok' in result && result.ok === true, 'fresh feature branch → ok');
  assert.ok(
    calls.includes('merge-base --is-ancestor origin/master HEAD'),
    'feature branch must verify origin/base ancestry',
  );
});

test('preflightLive: clean feature branch not based on origin/base → needsHuman', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature-branch\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'bbb222\n';
      if (
        args[0] === 'merge-base' &&
        args[1] === '--is-ancestor' &&
        args[2] === 'origin/master' &&
        args[3] === 'HEAD'
      ) {
        throw new Error('not ancestor');
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'stale feature branch must block');
  assert.ok(result.lesson.includes('not based on fresh origin/master'), `lesson: ${result.lesson}`);
});

test('preflightLive: clean base branch BEHIND origin → self-heals via fast-forward → ok (slice 142)', async () => {
  const calls: string[] = [];
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      calls.push(args.join(' '));
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'master\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'bbb222\n';
      // base behind: HEAD is an ancestor of origin/master → success
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === 'HEAD' && args[3] === 'origin/master') return '';
      if (args[0] === 'merge' && args[1] === '--ff-only' && args[2] === 'origin/master') return '';
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('ok' in result && result.ok === true, 'a base merely behind origin self-heals, not blocks');
  assert.ok(calls.includes('merge --ff-only origin/master'), 'fast-forwarded the clean base to origin/master');
});

test('preflightLive: clean base branch DIVERGED from origin → needsHuman (no silent reset)', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'status' && args[1] === '--porcelain') return '';
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'master\n';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaa111\n';
      if (args[0] === 'rev-parse' && args[1] === 'origin/master') return 'bbb222\n';
      // diverged: HEAD is NOT an ancestor of origin/master → throw
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') throw new Error('not ancestor');
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
  };

  const result = await preflightLive('task-001', 'master', deps);
  assert.ok('needsHuman' in result, 'a diverged base must block (never auto-reset away local commits)');
  assert.ok(result.lesson.includes('DIVERGED'), `lesson: ${result.lesson}`);
});

test('preflightLive: fetch failure → needsHuman (no-base lesson)', async () => {
  const deps: IntegratorDeps = {
    execGit: (args, _cwd) => {
      if (args[0] === 'fetch') throw new Error('fatal: branch not found');
      throw new Error(`unexpected: ${args.join(' ')}`);
    },
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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
    resolveRunCwd: makeResolveRunCwd(),
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

// ─── confirmMerge (plan 0017 follow-up: gate cleanup on a real merge) ─────────

const MERGE_INPUT: IntegratorInput = { runId: 'r1', taskId: 't1', title: 'T', base: 'master' };

// Mirrors REAL gh: no `merged` field — `state` (OPEN|MERGED|CLOSED) is the merged indicator. The
// integrator opens PRs as drafts, so `isDraft` gates whether confirmMerge must `gh pr ready` first.
function prView(state: string, mergeStateStatus: string, isDraft = false, number = 7): string {
  return JSON.stringify({ number, url: `https://gh/pr/${number}`, state, isDraft, mergeStateStatus });
}

/** Deps for confirmMerge: a git that reports a github origin, plus the supplied scripted gh. */
function confirmDeps(execGh: ExecGhFn): IntegratorDeps {
  const execGit: ExecFn = (args) =>
    args[0] === 'remote' && args[1] === 'get-url' ? 'git@github.com:e2e/repo.git\n' : '';
  return {
    execGit,
    execGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
  };
}

test('confirmMerge: already merged → merged, never calls `pr merge`', async () => {
  const calls: string[][] = [];
  const gh: ExecGhFn = (a) => { calls.push(a); return prView('MERGED', 'CLEAN'); };
  const r = await confirmMerge(MERGE_INPUT, confirmDeps(gh));
  assert.deepEqual(r, { merged: true, prNumber: 7, prUrl: 'https://gh/pr/7' });
  assert.ok(!calls.some((a) => a[1] === 'merge'), 'no pr merge when already merged');
});

test('confirmMerge: OPEN + CLEAN draft → marks ready, squash-merges, confirms merged', async () => {
  const calls: string[][] = [];
  let views = 0;
  const gh: ExecGhFn = (a) => {
    calls.push(a);
    // First view: the integrator's DRAFT, CLEAN. After merge: MERGED.
    if (a[1] === 'view') { views++; return views === 1 ? prView('OPEN', 'CLEAN', true) : prView('MERGED', 'CLEAN'); }
    return '';
  };
  const r = await confirmMerge(MERGE_INPUT, confirmDeps(gh));
  assert.equal('merged' in r && r.merged, true);
  const readyIdx = calls.findIndex((a) => a[1] === 'ready');
  const mergeIdx = calls.findIndex((a) => a[1] === 'merge');
  assert.ok(readyIdx >= 0, 'a draft PR is marked ready before merge');
  assert.ok(mergeIdx > readyIdx, 'ready precedes merge');
  assert.ok(calls[mergeIdx].includes('--squash') && calls[mergeIdx].includes('--delete-branch'), 'squash + delete-branch merge');
});

test('confirmMerge: OPEN but not CLEAN (red CI / conflicts) → blocked, no merge', async () => {
  const calls: string[][] = [];
  const gh: ExecGhFn = (a) => { calls.push(a); return prView('OPEN', 'BLOCKED'); };
  const r = await confirmMerge(MERGE_INPUT, confirmDeps(gh));
  assert.ok('needsHuman' in r, 'blocked when not CLEAN');
  assert.ok(!calls.some((a) => a[1] === 'merge'), 'never auto-merges a non-CLEAN PR');
});

test('confirmMerge: closed and not merged → blocked', async () => {
  const gh: ExecGhFn = () => prView('CLOSED', 'UNKNOWN');
  const r = await confirmMerge(MERGE_INPUT, confirmDeps(gh));
  assert.ok('needsHuman' in r);
});

test('confirmMerge: merge does not take effect (still not merged) → blocked', async () => {
  const gh: ExecGhFn = (a) => (a[1] === 'view' ? prView('OPEN', 'CLEAN') : '');
  const r = await confirmMerge(MERGE_INPUT, confirmDeps(gh));
  assert.ok('needsHuman' in r, 'blocked if the post-merge re-view is still not merged');
});

// ─── pollPr (plan 0018: observe + classify by feedback type) ──────────────────

const POLL_INPUT: IntegratorInput = { runId: 'r1', taskId: 't1', title: 'Add feature X', base: 'master' };

/** A readiness with no pending checks (terminal) — `fail` ∩ list are the failing checks. */
function readiness(opts: {
  fail?: string[];
  list?: Array<{ name: string; result: string }>;
  threads?: PollPrReadiness['reviewThreads']['items'];
  pending?: string[];
  headSha?: string;
}): PollPrReadiness {
  return {
    pr: { number: 5, headSha: opts.headSha ?? 'sha5' },
    checks: { pending: opts.pending ?? [], fail: opts.fail ?? [], list: opts.list ?? [{ name: 'build', result: 'SUCCESS' }] },
    reviewThreads: { items: opts.threads ?? [] },
  };
}

/** pollPr deps that report a github origin + a scripted readiness collector (no real gh/sleep). */
function pollDeps(collect: PollPrDeps['collect'], extra: Partial<PollPrDeps> = {}): PollPrDeps {
  const execGit: ExecFn = (args) => (args[0] === 'remote' && args[1] === 'get-url' ? 'git@github.com:e2e/repo.git\n' : '');
  return {
    execGit,
    execGh: neverGh,
    resolveTaskCwd: makeResolveTaskCwd(),
    resolveRunCwd: makeResolveRunCwd(),
    collect,
    sleep: () => Promise.resolve(),
    maxPolls: 3,
    ...extra,
  };
}

test('pollPr: unresolved review threads win over CI failures → review_changes', async () => {
  const collect = async (): Promise<PollPrReadiness> =>
    readiness({ fail: ['build'], list: [{ name: 'build', result: 'FAILURE' }], threads: [
      { id: 'T1', isResolved: false, isOutdated: false, body: 'fix this', path: 'a.ts', line: 3, author: 'cr' },
    ] });
  const r = await pollPr(POLL_INPUT, pollDeps(collect));
  assert.ok(!('needsHuman' in r));
  if (!('needsHuman' in r)) {
    assert.equal(r.verdict, 'review_changes', 'review threads outrank CI failures');
    assert.equal(r.reviewThreads.length, 1);
    assert.equal(r.reviewThreads[0]?.threadId, 'T1', 'the GraphQL node id is carried as threadId');
    assert.equal(r.ciFailures.length, 1, 'CI failures still collected (for downstream)');
  }
});

test('pollPr: CI failures with no review threads → ci_changes', async () => {
  const collect = async (): Promise<PollPrReadiness> =>
    readiness({ fail: ['build', 'lint'], list: [{ name: 'build', result: 'FAILURE' }, { name: 'lint', result: 'FAILURE' }] });
  const r = await pollPr(POLL_INPUT, pollDeps(collect));
  assert.ok(!('needsHuman' in r));
  if (!('needsHuman' in r)) {
    assert.equal(r.verdict, 'ci_changes');
    assert.deepEqual(r.ciFailures.map((c) => c.name), ['build', 'lint']);
    assert.equal(r.reviewThreads.length, 0);
  }
});

test('pollPr: all green, no threads → clean', async () => {
  const collect = async (): Promise<PollPrReadiness> => readiness({});
  const r = await pollPr(POLL_INPUT, pollDeps(collect));
  assert.ok(!('needsHuman' in r));
  if (!('needsHuman' in r)) assert.equal(r.verdict, 'clean');
});

test('pollPr: checks pending until terminal → polls then classifies', async () => {
  let calls = 0;
  const collect = async (): Promise<PollPrReadiness> => {
    calls++;
    return calls < 2 ? readiness({ pending: ['build'], list: [{ name: 'build', result: 'IN_PROGRESS' }] }) : readiness({});
  };
  // reviewGracePolls: 0 isolates the CI-polling assertion from the review-grace re-polls (slice 142).
  const r = await pollPr(POLL_INPUT, pollDeps(collect, { reviewGracePolls: 0 }));
  assert.ok(!('needsHuman' in r) && r.verdict === 'clean', 'converges once CI is terminal');
  assert.equal(calls, 2, 'polled until checks went terminal');
});

test('pollPr: CI green flips the draft PR to ready-for-review (slice 142)', async () => {
  const ghCalls: string[][] = [];
  const collect = async (): Promise<PollPrReadiness> => readiness({});
  const deps = pollDeps(collect, { reviewGracePolls: 0 });
  deps.execGh = (args) => { ghCalls.push(args); return ''; };
  const r = await pollPr(POLL_INPUT, deps);
  assert.ok(!('needsHuman' in r) && r.verdict === 'clean');
  assert.ok(
    ghCalls.some((a) => a[0] === 'pr' && a[1] === 'ready'),
    'CI green readies the draft PR so reviewers engage',
  );
});

test('pollPr: CI red does NOT ready the PR (no review of broken code) → ci_changes', async () => {
  const ghCalls: string[][] = [];
  const collect = async (): Promise<PollPrReadiness> =>
    readiness({ fail: ['build'], list: [{ name: 'build', result: 'FAILURE' }] });
  const deps = pollDeps(collect, { reviewGracePolls: 0 });
  deps.execGh = (args) => { ghCalls.push(args); return ''; };
  const r = await pollPr(POLL_INPUT, deps);
  assert.ok(!('needsHuman' in r) && r.verdict === 'ci_changes');
  assert.ok(!ghCalls.some((a) => a[0] === 'pr' && a[1] === 'ready'), 'a red-CI PR stays draft');
});

test('pollPr: a review thread surfacing DURING the grace window → review_changes (not premature clean)', async () => {
  let calls = 0;
  const thread = { id: 'T1', path: 'a.ts', line: 1, author: 'coderabbit', body: 'fix this', isResolved: false, isOutdated: false };
  const collect = async (): Promise<PollPrReadiness> => {
    calls++;
    // CI terminal+green from the start, but the review thread only lands on the 3rd read (during grace).
    return calls < 3 ? readiness({}) : readiness({ threads: [thread] });
  };
  const r = await pollPr(POLL_INPUT, pollDeps(collect, { reviewGracePolls: 5 }));
  assert.ok(!('needsHuman' in r) && r.verdict === 'review_changes', 'waits out the grace and catches the late review');
  assert.ok(!('needsHuman' in r) && r.reviewThreads.length === 1);
});

test('pollPr: no review thread after the grace → clean (merge gate is the backstop, never blocks)', async () => {
  const collect = async (): Promise<PollPrReadiness> => readiness({});
  const r = await pollPr(POLL_INPUT, pollDeps(collect, { reviewGracePolls: 3 }));
  assert.ok(!('needsHuman' in r) && r.verdict === 'clean', 'absent reviewer falls through to the human merge gate, not a block');
});

test('pollPr: timeout with checks still pending → needsHuman (block)', async () => {
  const collect = async (): Promise<PollPrReadiness> => readiness({ pending: ['build'], list: [{ name: 'build', result: 'IN_PROGRESS' }] });
  const r = await pollPr(POLL_INPUT, pollDeps(collect, { maxPolls: 2 }));
  assert.ok('needsHuman' in r, 'a poll timeout with pending checks blocks for a human');
  assert.ok(r.lesson.includes('timed out'), `lesson: ${r.lesson}`);
});

test('pollPr: unparseable origin → needsHuman (no poll)', async () => {
  let polled = false;
  const collect = async (): Promise<PollPrReadiness> => { polled = true; return readiness({}); };
  const deps = pollDeps(collect);
  deps.execGit = () => { throw new Error('fatal: not a git repo'); };
  const r = await pollPr(POLL_INPUT, deps);
  assert.ok('needsHuman' in r, 'no parseable remote blocks before polling');
  assert.equal(polled, false, 'never polled when the remote is unparseable');
});

// ─── respondThreads (plan 0018: reply + resolve the triaged threads) ──────────

/** Capture the gh GraphQL mutations respondThreads issues. */
function captureGh(calls: string[][]): ExecGhFn {
  return (args) => { calls.push(args); return JSON.stringify({ data: {} }); };
}

test('respondThreads: fix + wontfix each reply then resolve; question is skipped', async () => {
  const calls: string[][] = [];
  const triage: Triage = {
    items: [
      { threadId: 'T1', decision: 'fix', replyText: 'fixed in abc123' },
      { threadId: 'T2', decision: 'wontfix', replyText: 'out of scope' },
      { threadId: 'T3', decision: 'question', replyText: 'should not post' },
    ],
  };
  const r = await respondThreads(triage, { execGh: captureGh(calls) });
  assert.deepEqual(r, { replied: 2, resolved: 2 }, 'only fix + wontfix are acted on (question skipped)');

  const mutations = calls.filter((a) => a[0] === 'api' && a[1] === 'graphql');
  const replies = mutations.filter((a) => a.some((s) => s.includes('addPullRequestReviewThreadReply')));
  const resolves = mutations.filter((a) => a.some((s) => s.includes('resolveReviewThread')));
  assert.equal(replies.length, 2, 'two replies posted (fix + wontfix)');
  assert.equal(resolves.length, 2, 'two threads resolved (fix + wontfix)');

  // The reply + resolve target the thread by its GraphQL node id (threadId), and never T3 (question).
  const ids: string[] = mutations.flatMap((a) => a.filter((s) => /^id=T/.test(s)));
  assert.ok(ids.every((s) => ['id=T1', 'id=T2'].includes(s)), `only acted-on thread ids: ${ids.join(',')}`);
  assert.ok(!ids.some((s) => s === 'id=T3'), 'a question thread is never replied/resolved');
});

test('respondThreads: a fix reply precedes its resolve (reply-then-resolve order)', async () => {
  const calls: string[][] = [];
  const triage: Triage = { items: [{ threadId: 'T1', decision: 'fix', replyText: 'done' }] };
  await respondThreads(triage, { execGh: captureGh(calls) });
  const replyIdx = calls.findIndex((a) => a.some((s) => s.includes('addPullRequestReviewThreadReply')));
  const resolveIdx = calls.findIndex((a) => a.some((s) => s.includes('resolveReviewThread')));
  assert.ok(replyIdx >= 0 && resolveIdx > replyIdx, 'reply is posted before the thread is resolved');
});

test('respondThreads: empty triage → no gh calls', async () => {
  const calls: string[][] = [];
  const r = await respondThreads({ items: [] }, { execGh: captureGh(calls) });
  assert.deepEqual(r, { replied: 0, resolved: 0 });
  assert.equal(calls.length, 0, 'no threads → no gh mutations');
});
