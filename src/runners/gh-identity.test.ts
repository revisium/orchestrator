/**
 * gh-identity.test.ts — 0008 #1: gh account pinning (no ambient-account dependency).
 *
 * Exercises the REAL functions (resolveGhAccount / ghTokenEnvKey / resolveGhToken /
 * makeExecGh / redactTokens) with an injected execFile fake — no real gh, no real token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGhAccount,
  ghTokenEnvKey,
  resolveGhToken,
  makeExecGh,
  resolvePinnedGh,
  redactTokens,
  type ExecFileFn,
} from './gh-identity.js';

test('resolveGhAccount: resolves the active gh account when env and explicit account are absent', () => {
  const execFile: ExecFileFn = (_file, args) => {
    assert.deepEqual(args, ['api', 'user', '--jq', '.login']);
    return 'active-user\n';
  };
  assert.equal(resolveGhAccount({ env: {}, execFile }), 'active-user');
});

test('resolveGhAccount: explicit account wins over host env and active gh account', () => {
  let called = false;
  const execFile: ExecFileFn = () => {
    called = true;
    return 'active-user\n';
  };
  assert.equal(resolveGhAccount({ account: 'profile-bot', env: { REVO_GH_ACCOUNT: 'env-bot' }, execFile }), 'profile-bot');
  assert.equal(called, false);
});

test('resolveGhAccount: host env wins over active gh account', () => {
  let called = false;
  const execFile: ExecFileFn = () => {
    called = true;
    return 'active-user\n';
  };
  assert.equal(resolveGhAccount({ env: { REVO_GH_ACCOUNT: 'env-bot' }, execFile }), 'env-bot');
  assert.equal(called, false);
});

test('resolveGhAccount: returns undefined when no account can be resolved', () => {
  const execFile: ExecFileFn = () => {
    throw new Error('not authenticated');
  };
  assert.equal(resolveGhAccount({ env: {}, execFile }), undefined);
});

test('ghTokenEnvKey: derives an env-safe per-account key', () => {
  assert.equal(ghTokenEnvKey('profile-bot'), 'GH_TOKEN_PROFILE_BOT');
  assert.equal(ghTokenEnvKey('my.bot-9'), 'GH_TOKEN_MY_BOT_9');
});

test('resolveGhToken: env override GH_TOKEN_<ACCOUNT> wins without shelling out', () => {
  let called = false;
  const execFile: ExecFileFn = () => {
    called = true;
    return '';
  };
  const token = resolveGhToken('profile-bot', {
    env: { GH_TOKEN_PROFILE_BOT: 'gho_fromenv' },
    execFile,
  });
  assert.equal(token, 'gho_fromenv');
  assert.equal(called, false, 'must NOT shell out to gh when env override is present');
});

test('resolveGhToken: falls back to `gh auth token --user <account>` keyring', () => {
  let seenArgs: string[] = [];
  const execFile: ExecFileFn = (_file, args) => {
    seenArgs = args;
    return 'gho_fromkeyring\n';
  };
  const token = resolveGhToken('profile-bot', { env: {}, execFile });
  assert.equal(token, 'gho_fromkeyring');
  assert.deepEqual(seenArgs, ['auth', 'token', '--user', 'profile-bot']);
});

test('resolveGhToken: returns undefined when gh fails (account not in keyring)', () => {
  const execFile: ExecFileFn = () => {
    throw new Error('no such account');
  };
  assert.equal(resolveGhToken('profile-bot', { env: {}, execFile }), undefined);
});

test('makeExecGh: pins GH_TOKEN on the spawned gh process when a token is supplied', () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const execFile: ExecFileFn = (_file, _args, opts) => {
    seenEnv = opts.env;
    return 'ok';
  };
  const exec = makeExecGh({ token: 'gho_pinned', execFile, env: { PATH: '/usr/bin' } });
  const out = exec(['pr', 'create']);
  assert.equal(out, 'ok');
  assert.equal(seenEnv?.GH_TOKEN, 'gho_pinned', 'GH_TOKEN must be set so gh ignores the active account');
  assert.equal(seenEnv?.PATH, '/usr/bin', 'base env must be preserved');
});

test('makeExecGh: leaves the ambient account untouched when no token is resolved', () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const execFile: ExecFileFn = (_file, _args, opts) => {
    seenEnv = opts.env;
    return 'ok';
  };
  const exec = makeExecGh({ execFile, env: { PATH: '/usr/bin' } });
  exec(['pr', 'list']);
  assert.equal(seenEnv?.GH_TOKEN, undefined, 'GH_TOKEN must NOT be injected when no token resolved');
});

test('resolvePinnedGh: returns a pinned execGh when an explicit account token resolves', () => {
  const execFile: ExecFileFn = (_file, args, opts) => {
    if (args[0] === 'auth') return 'gho_pinnedtoken\n';
    return opts.env?.GH_TOKEN === 'gho_pinnedtoken' ? 'profile-bot' : 'WRONG';
  };
  const result = resolvePinnedGh({ account: 'profile-bot', env: {}, execFile });
  assert.ok(!('needsHuman' in result), 'must resolve to a pinned execGh');
  if (!('needsHuman' in result)) {
    assert.equal(result.account, 'profile-bot');
    assert.equal(result.execGh(['api', 'user']), 'profile-bot', 'pinned execGh uses the resolved token');
  }
});

test('resolvePinnedGh: FAILS LOUD (needsHuman) when the token cannot be resolved — never falls back to ambient', () => {
  const execFile: ExecFileFn = () => {
    throw new Error('keychain unavailable (detached host)');
  };
  const result = resolvePinnedGh({ account: 'profile-bot', env: {}, execFile });
  assert.ok('needsHuman' in result, 'must block, not fall back to ambient');
  if ('needsHuman' in result) {
    assert.match(result.lesson, /REFUSING to fall back/i);
    assert.match(result.lesson, /GH_TOKEN_PROFILE_BOT/, 'lesson names the keyring-free env fix');
  }
});

test('resolvePinnedGh: env override resolves headless without touching the keyring', () => {
  let shelledOut = false;
  const execFile: ExecFileFn = (_file, args, opts) => {
    if (args[0] === 'auth') { shelledOut = true; return ''; }
    return opts.env?.GH_TOKEN === 'gho_fromenv' ? 'profile-bot' : 'WRONG';
  };
  const result = resolvePinnedGh({ account: 'profile-bot', env: { GH_TOKEN_PROFILE_BOT: 'gho_fromenv' }, execFile });
  assert.ok(!('needsHuman' in result));
  assert.equal(shelledOut, false, 'env override must NOT shell out to the keyring (headless-safe)');
});

test('redactTokens: masks GitHub token shapes in free text', () => {
  const dirty =
    'failed with gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and github_pat_11ABCDEFG0abcdefghij1234567890';
  const clean = redactTokens(dirty);
  assert.ok(!clean.includes('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'gho_ token must be masked');
  assert.ok(!clean.includes('github_pat_11ABCDEFG0abcdefghij1234567890'), 'github_pat must be masked');
  assert.match(clean, /\[REDACTED\]/);
});
