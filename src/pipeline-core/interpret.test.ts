/**
 * interpret.test.ts — the pure reducer `step()` + `drive()` over the real + targeted fixtures.
 *
 * Reads as behaviour sentences via the kit (mirrors the e2e suite): "approve-path → succeeded",
 * "reviewer BLOCKER ×N → blocked at the cap", "choice routes on a domain verdict", "fork/join all+any",
 * "nested scope reset". Covers the §3 guard model, §4 fork/join, §6 failure precedence, §7 counters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, selectJoinWinner, step, InterpretError } from './interpret.js';
import {
  assertCounter,
  assertPath,
  assertReachesTerminal,
  assertVisitCount,
  drive,
  featureDevelopment,
  gateWithTimeout,
  localChange,
  nestedScopeLoop,
  node,
  parallelReview,
  template,
} from './kit/index.js';
import type { JoinArrival } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// feature-development — the canonical pipeline (§13).
// ─────────────────────────────────────────────────────────────────────────────

test('feature-development: approve-everywhere happy path reaches succeeded', () => {
  const result = drive(featureDevelopment(), {
    analyst: 'approved', //          (analyst result is irrelevant; planGate carries the verdict)
    planGate: 'approved',
    codeReview: 'approved',
    watcherPost: 'clean',
    mergeGate: 'approved',
  });
  assertReachesTerminal(result, 'succeeded');
  assertPath(result, [
    'analyst',
    'planGate',
    'developer',
    'codeReview',
    'integrator',
    'watcherPost',
    'mergeGate',
    'mergedEnd',
  ]);
});

test('feature-development: reviewer BLOCKER ×3 opens codeStuckGate then default blocks', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: 'blocker',
  });
  assertReachesTerminal(result, 'blocked');
  assertVisitCount(result, 'reworkDeveloper', 3);
  assertVisitCount(result, 'codeReview', 4);
  assertVisitCount(result, 'codeStuckGate', 1);
  assertCounter(result, 'codeReviewLoop', 3);
  assert.equal(result.path.at(-1), 'blockedEnd');
});

test('feature-development: one BLOCKER then APPROVED reworks once then integrates (counter increments once)', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: ['blocker', 'approved'], //   first pass blocks → rework; second pass approves
    watcherPost: 'clean',
    mergeGate: 'approved',
  });
  assertReachesTerminal(result, 'succeeded');
  assertVisitCount(result, 'reworkDeveloper', 1);
  assertCounter(result, 'codeReviewLoop', 1);
  assertPath(result, [
    'analyst',
    'planGate',
    'developer',
    'codeReview',
    'reworkDeveloper',
    'codeReview',
    'integrator',
    'watcherPost',
    'mergeGate',
    'mergedEnd',
  ]);
});

test('feature-development: one CHANGES_REQUESTED then APPROVED reworks once then integrates', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: ['changes_requested', 'approved'],
    watcherPost: 'clean',
    mergeGate: 'approved',
  });
  assertReachesTerminal(result, 'succeeded');
  assertVisitCount(result, 'reworkDeveloper', 1);
  assertCounter(result, 'codeReviewLoop', 1);
  assertPath(result, [
    'analyst',
    'planGate',
    'developer',
    'codeReview',
    'reworkDeveloper',
    'codeReview',
    'integrator',
    'watcherPost',
    'mergeGate',
    'mergedEnd',
  ]);
});

test('feature-development: plan gate rework loops back to the analyst', () => {
  const result = drive(featureDevelopment(), {
    planGate: ['rework', 'approved'],
    codeReview: 'approved',
    watcherPost: 'clean',
    mergeGate: 'approved',
  });
  assertReachesTerminal(result, 'succeeded');
  assertVisitCount(result, 'analyst', 2);
  assertVisitCount(result, 'planGate', 2);
});

test('feature-development: plan gate default (neither approved nor changes_requested) routes to blocked', () => {
  // A gate verdict outside the guarded set falls to the trailing default → blockedEnd (§3/§13).
  const result = drive(featureDevelopment(), { planGate: 'blocker' });
  assertReachesTerminal(result, 'blocked');
  assertPath(result, ['analyst', 'planGate', 'blockedEnd']);
});

test('feature-development: watcher dirty (domain verdict) routes to failed via the default', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: 'approved',
    watcherPost: 'dirty', //   not "clean" ⇒ watcherRouter default ⇒ failedEnd
  });
  assertReachesTerminal(result, 'failed');
  assert.equal(result.path.at(-1), 'failedEnd');
});

test('feature-development: integrator script error routes via catch (revo.ScriptFailed → failedEnd)', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: 'approved',
    integrator: { outcome: 'errored', errorCode: 'revo.ScriptFailed' },
  });
  assertReachesTerminal(result, 'failed');
  assert.equal(result.path.at(-1), 'failedEnd');
});

test('feature-development: merge gate non-named outcome routes to blocked', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: 'approved',
    watcherPost: 'clean',
    mergeGate: 'changes_requested', //   default ⇒ blockedEnd
  });
  assertReachesTerminal(result, 'blocked');
  assert.equal(result.path.at(-1), 'blockedEnd');
});

test('feature-development: merge gate recheck polls fresh readiness before reopening merge gate', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: 'approved',
    watcherPost: 'clean',
    mergeGate: ['recheck', 'approved'],
    mergeRecheck: 'clean',
  });

  assertReachesTerminal(result, 'succeeded');
  assertPath(result, [
    'analyst',
    'planGate',
    'developer',
    'codeReview',
    'integrator',
    'watcherPost',
    'mergeGate',
    'mergeRecheck',
    'mergeGate',
    'mergedEnd',
  ]);
});

test('feature-development: cancel gates reach cancelled terminal', () => {
  for (const [gate, script] of [
    ['planGate', { planGate: 'cancel' }],
    ['codeStuckGate', { planGate: 'approved', codeReview: 'blocker', codeStuckGate: 'cancel' }],
    ['mergeGate', { planGate: 'approved', codeReview: 'approved', watcherPost: 'clean', mergeGate: 'cancel' }],
  ] as const) {
    const result = drive(featureDevelopment(), script);
    assertReachesTerminal(result, 'cancelled');
    assert.equal(result.path.at(-1), 'cancelledEnd', gate);
  }
});

test('feature-development: codeStuckGate rework resets codeReviewLoop for a fresh review series', () => {
  const result = drive(featureDevelopment(), {
    planGate: 'approved',
    codeReview: ['blocker', 'blocker', 'blocker', 'blocker', 'blocker', 'approved'],
    codeStuckGate: 'rework',
    watcherPost: 'clean',
    mergeGate: 'approved',
  });

  assertReachesTerminal(result, 'succeeded');
  assertVisitCount(result, 'codeStuckGate', 1);
  assertVisitCount(result, 'stuckReworkDeveloper', 1);
  assertVisitCount(result, 'reworkDeveloper', 4);
  assertCounter(result, 'codeStuckRecoveryLoop', 1);
  assertCounter(result, 'codeReviewLoop', 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// local-change — the no-gate sibling (§13 footnote).
// ─────────────────────────────────────────────────────────────────────────────

test('local-change: orchestrator → developer → succeeded (no gate in the path)', () => {
  const result = drive(localChange());
  assertReachesTerminal(result, 'succeeded');
  assertPath(result, ['orchestrator', 'developer', 'doneEnd']);
  assert.ok(!result.trace.some((s) => s.decision === 'awaitGate'), 'local-change has no humanGate');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 failure precedence — abort / escalate (catch covered above via the integrator).
// ─────────────────────────────────────────────────────────────────────────────

test('failure precedence: onFailure=abort with no catch synthesizes complete{failed} at the node', () => {
  // local-change developer aborts on error (default onFailure) → complete{failed} AT developer, no
  // catch involved and no terminal node routed to. `developer` appears twice: invokeRole then complete.
  const result = drive(localChange(), {
    developer: { outcome: 'failed' },
  });
  assertReachesTerminal(result, 'failed');
  assertPath(result, ['orchestrator', 'developer', 'developer']);
  assert.equal(result.trace.at(-1)?.decision, 'complete');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 choice routing on a domain verdict (parallel-review's joinRouter, single-step focus).
// ─────────────────────────────────────────────────────────────────────────────

test('choice routes on a domain verdict (clean → done, otherwise → blocked)', () => {
  const clean = drive(parallelReview('all'), {
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'clean' }, { branchId: 'perf', seq: 2, verdict: 'clean' }] },
  });
  assertReachesTerminal(clean, 'succeeded');

  const dirty = drive(parallelReview('all'), {
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'clean' }, { branchId: 'perf', seq: 2, verdict: 'dirty' }] },
  });
  // 'all' forwards the LAST arrival's verdict (perf=dirty) → joinRouter default → blocked.
  assertReachesTerminal(dirty, 'blocked');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 fork / join — fork Decision shape; all vs any winner.
// ─────────────────────────────────────────────────────────────────────────────

test('parallel emits a fork Decision carrying branches, joinId and the join mode', () => {
  const t = parallelReview('any');
  const { decision } = step(t, initialState(t), undefined);
  assert.equal(decision.type, 'fork');
  if (decision.type !== 'fork') throw new Error('unreachable');
  assert.equal(decision.nodeId, 'fanout');
  assert.equal(decision.joinId, 'reviewJoin');
  assert.deepEqual(decision.mode, { kind: 'any' });
  assert.deepEqual(decision.branches.map((b) => b.id).sort(), ['perf', 'sec']);
});

test('join all forwards the last recorded arrival; the fork→join→router path completes', () => {
  const result = drive(parallelReview('all'), {
    reviewJoin: { joinArrivals: [{ branchId: 'perf', seq: 2, verdict: 'clean' }, { branchId: 'sec', seq: 1, verdict: 'clean' }] },
  });
  assertReachesTerminal(result, 'succeeded');
  assert.deepEqual(result.path, ['fanout', 'doneEnd']);
});

test('join verdictReducer allIn blocks when an earlier branch is non-passing even if the last arrival passes', () => {
  const t = parallelReview('all');
  const reviewJoin = t.nodes['reviewJoin'];
  assert.equal(reviewJoin?.kind, 'join');
  if (reviewJoin?.kind !== 'join') throw new Error('unreachable');
  t.nodes['reviewJoin'] = { ...reviewJoin, verdictReducer: { kind: 'allIn', pass: ['clean'], passVerdict: 'clean', failVerdict: 'dirty' } };
  const result = drive(t, {
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'dirty' }, { branchId: 'perf', seq: 2, verdict: 'clean' }] },
  });
  assertReachesTerminal(result, 'blocked');
});

test('join verdictReducer allIn passes approved plus clean when both are in the pass set', () => {
  const t = parallelReview('all');
  const reviewJoin = t.nodes['reviewJoin'];
  assert.equal(reviewJoin?.kind, 'join');
  if (reviewJoin?.kind !== 'join') throw new Error('unreachable');
  t.nodes['reviewJoin'] = {
    ...reviewJoin,
    verdictReducer: { kind: 'allIn', pass: ['approved', 'clean'], passVerdict: 'clean', failVerdict: 'dirty' },
  };
  const result = drive(t, {
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'approved' }, { branchId: 'perf', seq: 2, verdict: 'clean' }] },
  });
  assertReachesTerminal(result, 'succeeded');
});

test('join verdictReducer allIn blocks when the last branch is non-passing', () => {
  const t = parallelReview('all');
  const reviewJoin = t.nodes['reviewJoin'];
  assert.equal(reviewJoin?.kind, 'join');
  if (reviewJoin?.kind !== 'join') throw new Error('unreachable');
  t.nodes['reviewJoin'] = { ...reviewJoin, verdictReducer: { kind: 'allIn', pass: ['clean'], passVerdict: 'clean', failVerdict: 'dirty' } };
  const result = drive(t, {
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'clean' }, { branchId: 'perf', seq: 2, verdict: 'dirty' }] },
  });
  assertReachesTerminal(result, 'blocked');
});

test('join verdictReducer allIn treats a missing branch verdict as non-passing', () => {
  const t = parallelReview('all');
  const reviewJoin = t.nodes['reviewJoin'];
  assert.equal(reviewJoin?.kind, 'join');
  if (reviewJoin?.kind !== 'join') throw new Error('unreachable');
  t.nodes['reviewJoin'] = { ...reviewJoin, verdictReducer: { kind: 'allIn', pass: ['clean'], passVerdict: 'clean', failVerdict: 'dirty' } };
  const result = drive(t, {
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'clean' }, { branchId: 'perf', seq: 2 }] },
  });
  assertReachesTerminal(result, 'blocked');
});

test('selectJoinWinner: any picks lowest recorded seq (branchId tie-break)', () => {
  const arrivals: JoinArrival[] = [
    { branchId: 'perf', seq: 5, verdict: 'dirty' },
    { branchId: 'sec', seq: 2, verdict: 'clean' },
  ];
  assert.equal(selectJoinWinner({ kind: 'any' }, arrivals, 'j')?.branchId, 'sec');
});

test('selectJoinWinner: any tie on seq breaks by branchId (deterministic)', () => {
  const arrivals: JoinArrival[] = [
    { branchId: 'perf', seq: 1 },
    { branchId: 'sec', seq: 1 },
  ];
  assert.equal(selectJoinWinner({ kind: 'any' }, arrivals, 'j')?.branchId, 'perf');
});

test('selectJoinWinner: quorum picks the K-th arrival in recorded order', () => {
  const arrivals: JoinArrival[] = [
    { branchId: 'a', seq: 1 },
    { branchId: 'b', seq: 2 },
    { branchId: 'c', seq: 3 },
  ];
  assert.equal(selectJoinWinner({ kind: 'quorum', count: 2 }, arrivals, 'j')?.branchId, 'b');
});

test('selectJoinWinner: quorum with too few arrivals throws (a VALID template never feeds this)', () => {
  assert.throws(() => selectJoinWinner({ kind: 'quorum', count: 3 }, [{ branchId: 'a', seq: 1 }], 'j'), InterpretError);
});

test('join any winner verdict flows into the next router (any clean → done)', () => {
  const result = drive(parallelReview('any'), {
    // seq 1 (sec) is the winner under any; its verdict (clean) routes joinRouter → done.
    reviewJoin: { joinArrivals: [{ branchId: 'sec', seq: 1, verdict: 'clean' }, { branchId: 'perf', seq: 2, verdict: 'dirty' }] },
  });
  assertReachesTerminal(result, 'succeeded');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 nested/scoped counters — reset of a descendant scope on outer re-entry.
// ─────────────────────────────────────────────────────────────────────────────

test('nested scopes: inner cap routes to the outer loop, and the outer re-entry RESETS the inner counter', () => {
  // inner redo until inner cap (2) → outerRouter (outer<2) → outerWork (++outer, reset inner) →
  // innerWork (++inner=1) … the inner counter must restart from 0 after the outer hop, proving reset.
  const result = drive(nestedScopeLoop(), {
    innerWork: 'redo_inner', //   always asks to redo inner → drives inner to its cap each outer pass
  });
  assertReachesTerminal(result, 'blocked');
  // outer cap is 2: two outerWork passes, then outerRouter default → blocked.
  assertVisitCount(result, 'outerWork', 2);
  assertCounter(result, 'outer', 2);
  // After the final outer reset the inner ran up again; the final inner counter is the cap (2).
  assertCounter(result, 'inner', 2);
});

test('nested scopes: inner done short-circuits to succeeded without touching the outer counter', () => {
  const result = drive(nestedScopeLoop(), { innerWork: 'done' });
  assertReachesTerminal(result, 'succeeded');
  assertCounter(result, 'outer', 0);
  assertCounter(result, 'inner', 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 gate timeout — recorded timeout firing routes via timeout.goto, not a branch guard.
// ─────────────────────────────────────────────────────────────────────────────

test('gate timeout: a recorded timed_out outcome routes via timeout.goto (failedEnd), not a guard', () => {
  const result = drive(gateWithTimeout(), {
    gate: { outcome: 'timed_out' },
  });
  assertReachesTerminal(result, 'failed');
  assertPath(result, ['gate', 'failedEnd']);
});

test('gate timeout: an approved verdict still routes via the branch guard (doneEnd)', () => {
  const result = drive(gateWithTimeout(), { gate: 'approved' });
  assertReachesTerminal(result, 'succeeded');
  assertPath(result, ['gate', 'doneEnd']);
});

// ─────────────────────────────────────────────────────────────────────────────
// step() guard rails.
// ─────────────────────────────────────────────────────────────────────────────

test('step throws if more than one node is active without a fork in flight', () => {
  const t = localChange();
  const bad = { ...initialState(t), activeNodeIds: new Set(['orchestrator', 'developer']) };
  assert.throws(() => step(t, bad, undefined), InterpretError);
});

test('step throws on an empty active set (no cursor)', () => {
  const t = localChange();
  const bad = { ...initialState(t), activeNodeIds: new Set<string>() };
  assert.throws(() => step(t, bad, undefined), InterpretError);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 escalate — onFailure=escalate routes to escalateTo.
// ─────────────────────────────────────────────────────────────────────────────

test('failure precedence: onFailure=escalate routes to escalateTo', () => {
  const t = template('esc')
    .entry('worker')
    .domain('approved')
    .add(
      node.agent('worker', 'role:x', 'doneEnd', { onFailure: 'escalate', escalateTo: 'humanEnd' }),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('humanEnd', 'blocked'),
    )
    .build();
  const result = drive(t, { worker: { outcome: 'errored', errorCode: 'revo.Boom' } });
  assertReachesTerminal(result, 'blocked');
  assertPath(result, ['worker', 'humanEnd']);
});

test('failure precedence: catch beats onFailure=abort (matching code routes via catch)', () => {
  const t = template('catch')
    .entry('worker')
    .domain('approved')
    .add(
      node.script('worker', 'script:x', 'doneEnd', {
        onFailure: 'abort', // abort would fail; catch on the matching code wins (§6 precedence)
        catch: [{ onError: 'revo.Recoverable', goto: 'recoveredEnd' }],
      }),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('recoveredEnd', 'succeeded'),
    )
    .build();
  const result = drive(t, { worker: { outcome: 'errored', errorCode: 'revo.Recoverable' } });
  assertReachesTerminal(result, 'succeeded');
  assertPath(result, ['worker', 'recoveredEnd']);
});

test('failure precedence: a non-matching catch code falls through to onFailure=abort', () => {
  const t = template('catch2')
    .entry('worker')
    .domain('approved')
    .add(
      node.script('worker', 'script:x', 'doneEnd', {
        onFailure: 'abort',
        catch: [{ onError: 'revo.SomethingElse', goto: 'doneEnd' }],
      }),
      node.terminal('doneEnd', 'succeeded'),
    )
    .build();
  const result = drive(t, { worker: { outcome: 'failed', errorCode: 'revo.Unmatched' } });
  assertReachesTerminal(result, 'failed'); // no catch matched → abort
});

// ─────────────────────────────────────────────────────────────────────────────
// wait — startTimer then resume via next.
// ─────────────────────────────────────────────────────────────────────────────

test('wait emits startTimer then resumes via next on the recorded timer result', () => {
  const t = template('wait')
    .entry('pause')
    .domain('approved')
    .add(node.wait('pause', 'PT1H', 'doneEnd'), node.terminal('doneEnd', 'succeeded'))
    .build();
  // First step emits startTimer; the driver feeds an empty result; the next step resumes to doneEnd.
  const first = step(t, initialState(t), undefined);
  assert.equal(first.decision.type, 'startTimer');
  if (first.decision.type === 'startTimer') assert.equal(first.decision.duration, 'PT1H');
  const result = drive(t);
  assertReachesTerminal(result, 'succeeded');
  assertPath(result, ['pause', 'doneEnd']);
});

// ─────────────────────────────────────────────────────────────────────────────
// idempotent terminal re-resolution.
// ─────────────────────────────────────────────────────────────────────────────

test('re-resolving an already-active terminal re-asserts complete (idempotent replay)', () => {
  const t = localChange();
  const atTerminal = { ...initialState(t), activeNodeIds: new Set(['doneEnd']), status: 'succeeded' as const };
  const out = step(t, atTerminal, { verdict: 'approved' });
  assert.equal(out.decision.type, 'complete');
  if (out.decision.type === 'complete') assert.equal(out.decision.status, 'succeeded');
});
