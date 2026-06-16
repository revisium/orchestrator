/**
 * pipeline-core/kit/fixtures.ts — typed Template fixtures (the e2e-style "real pipelines" + targeted).
 *
 * `featureDevelopment` is the §13 canonical example, transcribed faithfully to a typed `Template`.
 * `localChange` is its no-gate sibling (§13 footnote). The rest are small, single-purpose fixtures:
 * nested-scope loops, a parallel/join, and one INVALID template per §12 rule (each named for the rule
 * + diagnostic it is designed to trip), so validation tests read as a rule catalogue.
 */

import {
  allOf,
  counterGte,
  counterLt,
  joinAll,
  joinAny,
  joinQuorum,
  node,
  on,
  otherwise,
  template,
  verdictEq,
} from './builders.js';
import type { Template } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// §13 — feature-development (the canonical example).
// ─────────────────────────────────────────────────────────────────────────────

export function featureDevelopment(): Template {
  return template('feature-development')
    .title('Feature development with plan + merge gates and bounded rework')
    .specVersion('1.0')
    .entry('analyst')
    .domain('approved', 'changes_requested', 'blocker', 'clean', 'dirty')
    .policy({ conflicts: [['developer', 'reviewer']], enforcement: 'strict' })
    .scope('codeReviewLoop', { cap: 3, parent: null })
    .add(
      node.agent('analyst', 'role:analyst', 'planGate', { resultSchema: 'schema:plan', onFailure: 'abort' }),
      node.humanGate('planGate', 'plan-review', ['approved', 'changes_requested'], [
        on(verdictEq('approved'), 'developer'),
        on(verdictEq('changes_requested'), 'analyst'),
        otherwise('blockedEnd'),
      ]),
      node.agent('developer', 'role:developer', 'codeReview', { resultSchema: 'schema:change', onFailure: 'abort' }),
      node.agent('codeReview', 'role:reviewer', 'codeReviewRouter', {
        resultSchema: 'schema:reviewVerdict',
        onFailure: 'abort',
      }),
      node.choice('codeReviewRouter', [
        on(verdictEq('approved'), 'integrator'),
        on(allOf(verdictEq('blocker'), counterLt('codeReviewLoop', 3)), 'reworkDeveloper'),
        otherwise('blockedEnd'),
      ]),
      node.agent('reworkDeveloper', 'role:developer', 'codeReview', {
        resultSchema: 'schema:change',
        incrementCounters: ['codeReviewLoop'],
        onFailure: 'abort',
      }),
      node.script('integrator', 'script:integrator', 'watcherPost', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'failedEnd' }],
      }),
      node.agent('watcherPost', 'role:watcher', 'watcherRouter', {
        resultSchema: 'schema:watchVerdict',
        onFailure: 'abort',
      }),
      node.choice('watcherRouter', [on(verdictEq('clean'), 'mergeGate'), otherwise('failedEnd')]),
      node.humanGate('mergeGate', 'merge-review', ['approved', 'changes_requested'], [
        on(verdictEq('approved'), 'mergedEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('mergedEnd', 'succeeded'),
      node.terminal('failedEnd', 'failed'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 footnote — local-change (orchestrator + developer, NO humanGate).
// ─────────────────────────────────────────────────────────────────────────────

export function localChange(): Template {
  return template('local-change')
    .title('Local change — orchestrator + developer, no gate')
    .entry('orchestrator')
    .domain('approved')
    .add(
      node.agent('orchestrator', 'role:orchestrator', 'developer', { resultSchema: 'schema:plan' }),
      node.agent('developer', 'role:developer', 'doneEnd', { resultSchema: 'schema:change' }),
      node.terminal('doneEnd', 'succeeded'),
    )
    .build();
}

// ─────────────────────────────────────────────────────────────────────────────
// Targeted — a nested-scope rework loop (inner loop resets on outer re-entry, §7).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * outer (cap 2) ⊃ inner (cap 2). `outerWork` increments `outer` (and resets `inner`); `innerWork`
 * increments `inner`. The inner cap routes back to the outer loop; the outer cap routes to blocked.
 */
export function nestedScopeLoop(): Template {
  return template('nested-scope-loop')
    .entry('start')
    .domain('redo_inner', 'redo_outer', 'done')
    .scope('outer', { cap: 2, parent: null })
    .scope('inner', { cap: 2, parent: 'outer' })
    .add(
      node.agent('start', 'role:worker', 'innerWork'),
      node.agent('innerWork', 'role:worker', 'innerRouter', { incrementCounters: ['inner'] }),
      node.choice('innerRouter', [
        on(verdictEq('done'), 'doneEnd'),
        on(allOf(verdictEq('redo_inner'), counterLt('inner', 2)), 'innerWork'),
        on(counterGte('inner', 2), 'outerRouter'),
        otherwise('blockedEnd'),
      ]),
      node.choice('outerRouter', [
        on(counterLt('outer', 2), 'outerWork'),
        otherwise('blockedEnd'),
      ]),
      node.agent('outerWork', 'role:worker', 'innerWork', { incrementCounters: ['outer'] }),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

// ─────────────────────────────────────────────────────────────────────────────
// Targeted — a parallel/join (two review branches → join → terminal).
// ─────────────────────────────────────────────────────────────────────────────

/** Map a join-mode kind to its `JoinMode` (quorum fixed at 2 for this fan-out shape). */
function joinModeFromKind(kind: 'all' | 'any' | 'quorum') {
  if (kind === 'all') return joinAll();
  if (kind === 'any') return joinAny();
  return joinQuorum(2);
}

/** `joinModeKind` selects `all` (default), `any`, or `quorum{2}` on the same fan-out shape. */
export function parallelReview(joinModeKind: 'all' | 'any' | 'quorum' = 'all'): Template {
  const mode = joinModeFromKind(joinModeKind);
  return template('parallel-review')
    .entry('fanout')
    .domain('clean', 'dirty', 'approved')
    .add(
      node.parallel('fanout', [
        { id: 'sec', entry: 'secReview' },
        { id: 'perf', entry: 'perfReview' },
      ], 'reviewJoin'),
      node.agent('secReview', 'role:reviewer', 'reviewJoin'),
      node.agent('perfReview', 'role:reviewer', 'reviewJoin'),
      // `merge` declared so the 2-writer fan-out is well-formed under all modes (§12.8).
      node.join('reviewJoin', mode, 'joinRouter', { merge: { findings: 'appendByBranchOrder' } }),
      node.choice('joinRouter', [on(verdictEq('clean'), 'doneEnd'), otherwise('blockedEnd')]),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

// ─────────────────────────────────────────────────────────────────────────────
// Targeted — a gate with a timeout edge (§6) + a node with onFailure=route+catch (§6).
// ─────────────────────────────────────────────────────────────────────────────

export function gateWithTimeout(): Template {
  return template('gate-with-timeout')
    .entry('gate')
    .domain('approved')
    .add(
      node.humanGate('gate', 'review', ['approved'], [on(verdictEq('approved'), 'doneEnd'), otherwise('blockedEnd')], {
        timeout: { after: 'PT24H', goto: 'failedEnd' },
      }),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('failedEnd', 'failed'),
    )
    .build();
}

// ─────────────────────────────────────────────────────────────────────────────
// INVALID fixtures — one per §12 rule. Each is the minimal shape that trips its rule.
// ─────────────────────────────────────────────────────────────────────────────

/** rule 1 — entry points at a node that does not exist (ENTRY_UNRESOLVED). */
export const invalidEntryUnresolved = (): Template =>
  template('inv').entry('ghost').domain('approved').add(node.terminal('end', 'succeeded')).build();

/** rule 2 — an edge points at a non-existent node (REF_UNRESOLVED). */
export const invalidRefUnresolved = (): Template =>
  template('inv').entry('a').domain('approved').add(node.agent('a', 'role:x', 'nowhere')).build();

/** rule 3 — a non-terminal with no exit (NONTERMINAL_NO_EXIT) — forced via a choice with no branches. */
export const invalidNonterminalNoExit = (): Template =>
  template('inv').entry('a').domain('approved').add(node.choice('a', [])).build();

/** rule 3 — a terminal with a bad status (TERMINAL_BAD_STATUS). */
export const invalidTerminalBadStatus = (): Template => {
  const t = template('inv').entry('a').domain('approved').add(node.terminal('a', 'succeeded')).build();
  (t.nodes['a'] as { status: string }).status = 'done'; // not in {succeeded,failed,blocked}
  return t;
};

/** rule 4 — a choice with no default (ROUTING_NO_DEFAULT). */
export const invalidNoDefault = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.choice('a', [on(verdictEq('approved'), 'end')]), node.terminal('end', 'succeeded'))
    .build();

/** rule 4 — a guard placed AFTER the default (ROUTING_GUARD_AFTER_DEFAULT). */
export const invalidGuardAfterDefault = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.choice('a', [otherwise('end'), on(verdictEq('approved'), 'end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 5 — a node unreachable from entry (UNREACHABLE_NODE). */
export const invalidUnreachable = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'end'),
      node.terminal('end', 'succeeded'),
      node.agent('orphan', 'role:y', 'end'),
    )
    .build();

/** rule 6 — an unbounded back-edge (LOOP_UNBOUNDED): a choice loops back with no counter.gte cap. */
export const invalidUnboundedLoop = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'router'),
      node.choice('router', [on(verdictEq('approved'), 'a'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 7 — a guard references an undeclared scope (SCOPE_UNDECLARED). */
export const invalidScopeUndeclared = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'router'),
      node.choice('router', [on(counterGte('ghostScope', 3), 'end'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 7 — a scope whose parent does not resolve (SCOPE_PARENT_UNRESOLVED). The scope is otherwise
 *  well-formed (incremented on its own loop) so the parent-unresolved finding stands alone. */
export const invalidScopeParent = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .scope('child', { cap: 2, parent: 'ghostParent' })
    .add(
      node.agent('a', 'role:x', 'router', { incrementCounters: ['child'] }),
      node.choice('router', [on(counterLt('child', 2), 'a'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 8 — quorum K > N (QUORUM_K_GT_N). */
export const invalidQuorumKgtN = (): Template =>
  template('inv')
    .entry('fanout')
    .domain('clean')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aWork' }, { id: 'b', entry: 'bWork' }], 'j'),
      node.agent('aWork', 'role:x', 'j'),
      node.agent('bWork', 'role:y', 'j'),
      node.join('j', joinQuorum(3), 'end', { merge: { f: 'overwrite' } }),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 8 — a cross-branch goto (BRANCH_CROSS_GOTO): branch a's node jumps into branch b. */
export const invalidCrossBranchGoto = (): Template =>
  template('inv')
    .entry('fanout')
    .domain('clean')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aWork' }, { id: 'b', entry: 'bWork' }], 'j'),
      node.agent('aWork', 'role:x', 'bWork'), // crosses into branch b
      node.agent('bWork', 'role:y', 'j'),
      node.join('j', joinAll(), 'end'),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 8 — a multi-writer fan-out with no merge reducer (MERGE_MISSING). */
export const invalidMissingMerge = (): Template =>
  template('inv')
    .entry('fanout')
    .domain('clean')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aWork' }, { id: 'b', entry: 'bWork' }], 'j'),
      node.agent('aWork', 'role:x', 'j'),
      node.agent('bWork', 'role:y', 'j'),
      node.join('j', joinAll(), 'end'), // no merge declared, 2 effect writers
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 9 — a guard uses an undeclared verdict (VERDICT_UNDECLARED). */
export const invalidVerdictUndeclared = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'router'),
      node.choice('router', [on(verdictEq('mystery'), 'end'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 9 — a guard uses a CORE verdict, which must route structurally (VERDICT_CORE_IN_GUARD). */
export const invalidCoreVerdictInGuard = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'router'),
      node.choice('router', [on(verdictEq('succeeded'), 'end'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 9 — a domain label shadows a core verdict (VERDICT_DOMAIN_SHADOWS_CORE). */
export const invalidDomainShadowsCore = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved', 'failed')
    .add(node.agent('a', 'role:x', 'end'), node.terminal('end', 'succeeded'))
    .build();

/** rule 9 — a gate outcome not in domain (GATE_OUTCOME_NOT_SUBSET). */
export const invalidGateOutcomeNotSubset = (): Template =>
  template('inv')
    .entry('g')
    .domain('approved')
    .add(
      node.humanGate('g', 'r', ['approved', 'rejected'], [on(verdictEq('approved'), 'end'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();

/** rule 11 — a node id that breaks the id pattern (ID_BAD_PATTERN). */
export const invalidBadId = (): Template => {
  const t = template('inv').entry('a').domain('approved').add(node.agent('a', 'role:x', 'end'), node.terminal('end', 'succeeded')).build();
  // Re-key 'a' to an illegal id and re-point entry.
  const a = t.nodes['a'];
  delete t.nodes['a'];
  (a as { id: string }).id = '1bad';
  t.nodes['1bad'] = a;
  t.entry = '1bad';
  return t;
};

/** rule 12 — a malformed capability ref (CAPABILITY_REF_SHAPE). */
export const invalidCapabilityRef = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.agent('a', 'not-a-role-handle', 'end'), node.terminal('end', 'succeeded'))
    .build();

/** rule 6 — onFailure=route with NO catch (FAILURE_ROUTE_NO_CATCH). */
export const invalidRouteNoCatch = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.script('a', 'script:x', 'end', { onFailure: 'route' }), node.terminal('end', 'succeeded'))
    .build();

/** rule 6 — onFailure=escalate with NO escalateTo (FAILURE_ESCALATE_NO_TARGET). */
export const invalidEscalateNoTarget = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.agent('a', 'role:x', 'end', { onFailure: 'escalate' }), node.terminal('end', 'succeeded'))
    .build();
