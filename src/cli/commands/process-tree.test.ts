/**
 * process-tree.test.ts — ancestry predicate `revo doctor` uses to tell its own standalone tier
 * (launcher → HTTP worker → embedded Postgres) from a genuine rogue daemon. The parent lookup is
 * injected so the traversal is exercised without real processes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPidWithin } from './process-tree.js';

// The real topology seen in dogfood: host daemon 84885 → standalone launcher 84887 → HTTP worker
// 84888 → embedded Postgres 84949. (host daemon is detached: its parent is init.)
const PARENTS: Record<number, number> = {
  84885: 1,
  84887: 84885,
  84888: 84887,
  84949: 84888,
};
const parentOf = (pid: number): number | null => PARENTS[pid] ?? null;

test('isPidWithin: the tracked pid itself is within', () => {
  assert.equal(isPidWithin(84887, new Set([84887]), parentOf), true);
});

test('isPidWithin: a direct child (HTTP worker) is within the tracked launcher', () => {
  assert.equal(isPidWithin(84888, new Set([84887]), parentOf), true);
});

test('isPidWithin: a grandchild (embedded Postgres) is within the tracked launcher', () => {
  assert.equal(isPidWithin(84949, new Set([84887]), parentOf), true);
});

test('isPidWithin: a pid outside the tracked tree is NOT within (a real rogue daemon)', () => {
  // 99999 descends from init, never through a tracked pid.
  assert.equal(isPidWithin(99999, new Set([84887]), () => 1), false);
});

test('isPidWithin: matches against any of several ancestors (host OR standalone)', () => {
  assert.equal(isPidWithin(84949, new Set([84885, 84887]), parentOf), true);
  assert.equal(isPidWithin(84885, new Set([84885, 84887]), parentOf), true);
});

test('isPidWithin: an empty ancestor set is never within', () => {
  assert.equal(isPidWithin(84888, new Set(), parentOf), false);
});

test('isPidWithin: a broken chain (unknown parent) terminates as not-within', () => {
  assert.equal(isPidWithin(55555, new Set([84887]), () => null), false);
});

test('isPidWithin: a cyclic parent chain is bounded by maxHops, returns false', () => {
  const cycle = (p: number): number => (p === 5 ? 6 : 5); // 5↔6 forever
  assert.equal(isPidWithin(5, new Set([84887]), cycle, 8), false);
});

test('isPidWithin: stops at init (pid 1) without looping', () => {
  assert.equal(isPidWithin(1, new Set([84887]), parentOf), false);
});
