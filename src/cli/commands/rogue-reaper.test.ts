import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRevoProcess, selectReapTargets, evictByTermination, type RevoProc } from './rogue-reaper.js';

test('classifyRevoProcess: the npm-GLOBAL daemon shape (bin/revo — symlink, no .js)', () => {
  // The real installed daemon runs as the bin SYMLINK name, no `.js` — the shape an earlier matcher missed.
  assert.equal(classifyRevoProcess('node /Users/x/.nvm/versions/node/v24.14.1/bin/revo __daemon'), 'daemon');
  assert.equal(classifyRevoProcess('node /Users/x/.nvm/versions/node/v24.14.1/bin/revo mcp'), 'mcp');
});

test('classifyRevoProcess: the packaged bin/revo.js __daemon shape', () => {
  assert.equal(classifyRevoProcess('node /Users/x/.nvm/versions/node/v24/bin/revo.js __daemon'), 'daemon');
});

test('classifyRevoProcess: installed mcp bridge (bin/revo.js mcp)', () => {
  assert.equal(classifyRevoProcess('node /Users/x/.nvm/versions/node/v24/bin/revo.js mcp'), 'mcp');
});

test('classifyRevoProcess: dev (tsx src/cli/index.ts) + compiled (dist/cli/index.js) shapes', () => {
  assert.equal(classifyRevoProcess('node --import tsx /repo/src/cli/index.ts __daemon'), 'daemon');
  assert.equal(classifyRevoProcess('/usr/bin/node /repo/dist/cli/index.js mcp'), 'mcp');
});

test('classifyRevoProcess: the running CLI itself (doctor/stop) is NOT a target', () => {
  assert.equal(classifyRevoProcess('node /Users/x/bin/revo.js doctor --fix'), null);
  assert.equal(classifyRevoProcess('node /Users/x/bin/revo.js stop --all'), null);
});

test('classifyRevoProcess: unrelated processes merely containing "mcp" are NOT matched', () => {
  assert.equal(classifyRevoProcess('node /opt/some-mcp-server.js'), null); // no revo entry token
  assert.equal(classifyRevoProcess('node /repo/bin/revo.js mcprouter'), null); // mcp not a whole word
  assert.equal(classifyRevoProcess('psql -h localhost'), null);
  assert.equal(classifyRevoProcess('node /repo/bin/revo.js __daemon-foo'), null); // not a whole word
});

const proc = (pid: number, command = 'node /x/bin/revo.js __daemon'): RevoProc => ({
  pid,
  command,
  startTime: 'Wed Jun 24 09:00:00 2026',
  kind: 'daemon',
});

test('selectReapTargets: the tracked pid + its descendants are protected; an outsider is a target', () => {
  // 200 is tracked; 201 is its child; 999 is unrelated (parent = init).
  const parents: Record<number, number> = { 201: 200, 200: 1, 999: 1 };
  const targets = selectReapTargets(
    [proc(200), proc(201), proc(999)],
    new Set([200]),
    (p) => parents[p] ?? null,
  );
  assert.deepEqual(targets.map((t) => t.pid), [999]);
});

test('selectReapTargets: protecting MULTIPLE profiles’ trees (cross-profile safety)', () => {
  // 100 = default daemon, 300 = dev daemon (both tracked); 500 = a legacy rogue.
  const parents: Record<number, number> = { 100: 1, 300: 1, 500: 1 };
  const targets = selectReapTargets(
    [proc(100), proc(300), proc(500)],
    new Set([100, 300]),
    (p) => parents[p] ?? null,
  );
  assert.deepEqual(targets.map((t) => t.pid), [500], 'never reaps a sibling profile’s live daemon');
});

test('evictByTermination: converges once terminate clears the roster (re-census confirms empty)', async () => {
  const rogues = new Set([5, 6]);
  const out = await evictByTermination(
    async () => [...rogues],
    async (pid) => void rogues.delete(pid),
  );
  // round 1: census [5,6] → terminate both; round 2: census [] → converged.
  assert.deepEqual(out, { converged: true, rounds: 2, terminated: 2 });
});

test('evictByTermination: an empty roster converges immediately, terminates nothing', async () => {
  const out = await evictByTermination(async () => [], async () => undefined);
  assert.deepEqual(out, { converged: true, rounds: 1, terminated: 0 });
});

test('evictByTermination: a RECONNECTING rogue never converges (bounded by maxRounds)', async () => {
  let terminated = 0;
  const out = await evictByTermination(
    async () => [9], // always present — reconnects after every kill
    async () => void (terminated += 1),
    3,
  );
  assert.equal(out.converged, false);
  assert.equal(out.rounds, 3);
  assert.equal(out.terminated, 3);
});

test('evictByTermination: a census error propagates (caller must treat as not-converged, never clean)', async () => {
  await assert.rejects(
    evictByTermination(
      async () => {
        throw new Error('permission denied');
      },
      async () => undefined,
    ),
    /permission denied/,
  );
});
