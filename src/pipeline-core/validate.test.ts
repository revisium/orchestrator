/**
 * validate.test.ts — the §12 validation rule catalogue.
 *
 * Reads as a rule-by-rule spec: each test names a §12 rule, drives a minimal fixture that violates it,
 * and asserts the expected diagnostic code (kit `assertHasDiagnostic`/`assertDiagnostics`). The two
 * real pipelines (§13 + footnote) and the targeted valid fixtures must produce NO errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplate } from './validate.js';
import {
  assertDiagnostics,
  assertHasDiagnostic,
  assertNoDiagnostic,
  assertValid,
  featureDevelopment,
  gateWithTimeout,
  invalidBadId,
  invalidCapabilityRef,
  invalidCoreVerdictInGuard,
  invalidCrossBranchGoto,
  invalidDomainShadowsCore,
  invalidEntryUnresolved,
  invalidEscalateNoTarget,
  invalidGateOutcomeNotSubset,
  invalidGuardAfterDefault,
  invalidMissingMerge,
  invalidNonterminalNoExit,
  invalidNoDefault,
  invalidQuorumKgtN,
  invalidRefUnresolved,
  invalidRouteNoCatch,
  invalidScopeParent,
  invalidScopeUndeclared,
  invalidTerminalBadStatus,
  invalidUnboundedLoop,
  invalidUnreachable,
  invalidVerdictUndeclared,
  localChange,
  nestedScopeLoop,
  node,
  on,
  otherwise,
  parallelReview,
  template,
  verdictEq,
} from './kit/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Valid templates → no errors (the real pipelines + targeted fixtures).
// ─────────────────────────────────────────────────────────────────────────────

test('valid: feature-development (§13 canonical) produces no errors', () => {
  assertValid(featureDevelopment());
});

test('valid: local-change (no gate) produces no errors', () => {
  assertValid(localChange());
});

test('valid: nested-scope loop produces no errors', () => {
  assertValid(nestedScopeLoop());
});

test('valid: parallel/join (all|any|quorum) produce no errors', () => {
  assertValid(parallelReview('all'));
  assertValid(parallelReview('any'));
  assertValid(parallelReview('quorum'));
});

test('valid: a gate with a timeout edge produces no errors', () => {
  assertValid(gateWithTimeout());
});

test('valid: a gate WITHOUT a timeout is allowed (timeout optional, §6)', () => {
  // feature-development's planGate/mergeGate have no timeout; assertValid above already covers it,
  // but assert explicitly that no timeout-related diagnostic exists.
  const diags = validateTemplate(featureDevelopment());
  assert.ok(!diags.some((d) => d.code.includes('TIMEOUT')), 'absent timeout must not be a diagnostic');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — single entry.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 1: entry that resolves to no node → ENTRY_UNRESOLVED', () => {
  assertHasDiagnostic(invalidEntryUnresolved(), 'ENTRY_UNRESOLVED');
});

test('rule 1: a missing entry → ENTRY_MISSING', () => {
  const t = template('inv').domain('approved').add(node.terminal('end', 'succeeded')).build();
  t.entry = '';
  assertHasDiagnostic(t, 'ENTRY_MISSING');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2 — references resolve.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 2: a dangling edge → REF_UNRESOLVED', () => {
  assertHasDiagnostic(invalidRefUnresolved(), 'REF_UNRESOLVED');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 — terminals & non-terminals.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 3: a terminal with a bad status → TERMINAL_BAD_STATUS', () => {
  assertHasDiagnostic(invalidTerminalBadStatus(), 'TERMINAL_BAD_STATUS');
});

test('rule 3: a non-terminal with no exit → NONTERMINAL_NO_EXIT', () => {
  assertHasDiagnostic(invalidNonterminalNoExit(), 'NONTERMINAL_NO_EXIT');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4 — total routing.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 4: a choice with no default → ROUTING_NO_DEFAULT', () => {
  assertDiagnostics(invalidNoDefault(), ['ROUTING_NO_DEFAULT']);
});

test('rule 4: a guard after the default → ROUTING_GUARD_AFTER_DEFAULT', () => {
  assertDiagnostics(invalidGuardAfterDefault(), ['ROUTING_GUARD_AFTER_DEFAULT']);
});

test('rule 4: two defaults → ROUTING_MULTIPLE_DEFAULT', () => {
  const t = template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.choice('a', [otherwise('end'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'ROUTING_MULTIPLE_DEFAULT');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 5 — reachability.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 5: a node unreachable from entry → UNREACHABLE_NODE', () => {
  assertHasDiagnostic(invalidUnreachable(), 'UNREACHABLE_NODE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6 — loop-cap presence + failure policy.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 6: an automated back-edge with no counter cap-guard → LOOP_UNBOUNDED', () => {
  assertDiagnostics(invalidUnboundedLoop(), ['LOOP_UNBOUNDED']);
});

test('rule 6: a human-gated loop with no counter is ALLOWED (resolved ambiguity, §6/§13)', () => {
  // analyst↔planGate in feature-development loops with no counter; it must NOT be LOOP_UNBOUNDED.
  assertNoDiagnostic(featureDevelopment(), 'LOOP_UNBOUNDED');
});

test('rule 6: onFailure=route with no catch → FAILURE_ROUTE_NO_CATCH', () => {
  assertDiagnostics(invalidRouteNoCatch(), ['FAILURE_ROUTE_NO_CATCH']);
});

test('rule 6: onFailure=escalate with no escalateTo → FAILURE_ESCALATE_NO_TARGET', () => {
  assertDiagnostics(invalidEscalateNoTarget(), ['FAILURE_ESCALATE_NO_TARGET']);
});

test('rule 6: a catch onError that is not a revo.* code → CATCH_BAD_CODE', () => {
  const t = template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.script('a', 'script:x', 'end', { onFailure: 'route', catch: [{ onError: 'notRevo' as `revo.${string}`, goto: 'end' }] }),
      node.terminal('end', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'CATCH_BAD_CODE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 7 — counter-scope well-formedness.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 7: a guard referencing an undeclared scope → SCOPE_UNDECLARED', () => {
  assertHasDiagnostic(invalidScopeUndeclared(), 'SCOPE_UNDECLARED');
});

test('rule 7: a scope whose parent does not resolve → SCOPE_PARENT_UNRESOLVED', () => {
  assertDiagnostics(invalidScopeParent(), ['SCOPE_PARENT_UNRESOLVED']);
});

test('rule 7: a scope read but never incremented → SCOPE_NOT_STRICT_ANCESTOR', () => {
  const t = template('inv')
    .entry('a')
    .domain('approved')
    .scope('deadScope', { cap: 3, parent: null })
    .add(
      node.agent('a', 'role:x', 'router'),
      node.choice('router', [on(verdictEq('approved'), 'end'), otherwise('a')]),
      node.terminal('end', 'succeeded'),
    )
    .build();
  // `router` reads no counter; inject a counter guard over the never-incremented deadScope to force 7c.
  (t.nodes['router'] as { branches: unknown[] }).branches = [
    { when: { op: 'counter.gte', scope: 'deadScope', value: 3 }, goto: 'end' },
    { default: 'a' },
  ];
  assertHasDiagnostic(t, 'SCOPE_NOT_STRICT_ANCESTOR');
});

test('rule 7: a parent cycle in scopes → SCOPE_CYCLE', () => {
  const t = nestedScopeLoop();
  t.scopes = { outer: { cap: 2, parent: 'inner' }, inner: { cap: 2, parent: 'outer' } };
  assertHasDiagnostic(t, 'SCOPE_CYCLE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 8 — parallel/join well-formedness.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 8: quorum K > N → QUORUM_K_GT_N', () => {
  assertHasDiagnostic(invalidQuorumKgtN(), 'QUORUM_K_GT_N');
});

test('rule 8: a cross-branch goto → BRANCH_CROSS_GOTO', () => {
  assertHasDiagnostic(invalidCrossBranchGoto(), 'BRANCH_CROSS_GOTO');
});

test('rule 8: a multi-writer fan-out with no merge → MERGE_MISSING', () => {
  assertHasDiagnostic(invalidMissingMerge(), 'MERGE_MISSING');
});

test('rule 8: a parallel join that is not a join node → PARALLEL_JOIN_KIND', () => {
  const t = template('inv')
    .entry('fanout')
    .domain('clean')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aw' }, { id: 'b', entry: 'bw' }], 'notJoin'),
      node.agent('aw', 'role:x', 'notJoin'),
      node.agent('bw', 'role:y', 'notJoin'),
      node.agent('notJoin', 'role:z', 'end'), // an agent, not a join
      node.terminal('end', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'PARALLEL_JOIN_KIND');
});

test('rule 8: lastWrite merge reducer is rejected → MERGE_LASTWRITE_REJECTED', () => {
  const t = parallelReview('all');
  (t.nodes['reviewJoin'] as { merge: Record<string, string> }).merge = { findings: 'lastWrite' };
  assertHasDiagnostic(t, 'MERGE_LASTWRITE_REJECTED');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 9 — verdict-vocabulary closure.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 9: a guard verdict not in domain → VERDICT_UNDECLARED', () => {
  assertHasDiagnostic(invalidVerdictUndeclared(), 'VERDICT_UNDECLARED');
});

test('rule 9: a CORE verdict used in a guard → VERDICT_CORE_IN_GUARD', () => {
  assertHasDiagnostic(invalidCoreVerdictInGuard(), 'VERDICT_CORE_IN_GUARD');
});

test('rule 9: a domain label shadowing a core label → VERDICT_DOMAIN_SHADOWS_CORE', () => {
  assertHasDiagnostic(invalidDomainShadowsCore(), 'VERDICT_DOMAIN_SHADOWS_CORE');
});

test('rule 9: a gate outcome outside domain → GATE_OUTCOME_NOT_SUBSET', () => {
  assertDiagnostics(invalidGateOutcomeNotSubset(), ['GATE_OUTCOME_NOT_SUBSET']);
});

test('rule 9: a declared-but-unused domain label → VERDICT_DECLARED_UNUSED (warning)', () => {
  const diags = validateTemplate(featureDevelopment());
  const unused = diags.find((d) => d.code === 'VERDICT_DECLARED_UNUSED');
  assert.ok(unused, 'feature-development declares `dirty`/`clean` etc.; an unused one warns');
  assert.equal(unused.severity, 'warning');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 11 — id/namespace hygiene.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 11: an id that breaks the pattern → ID_BAD_PATTERN', () => {
  assertHasDiagnostic(invalidBadId(), 'ID_BAD_PATTERN');
});

test('rule 11: a revo.* catch code colliding with a verdict label → REVO_CODE_COLLIDES_VERDICT', () => {
  // Declare a domain label that (illegally) looks like a revo code and use it as a catch onError.
  const t = template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.script('a', 'script:x', 'end', { onFailure: 'route', catch: [{ onError: 'approved' as `revo.${string}`, goto: 'end' }] }),
      node.terminal('end', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'REVO_CODE_COLLIDES_VERDICT');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 12 — capability-ref shape.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 12: a malformed roleRef → CAPABILITY_REF_SHAPE', () => {
  assertDiagnostics(invalidCapabilityRef(), ['CAPABILITY_REF_SHAPE']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 10 — conflict-matrix.
// ─────────────────────────────────────────────────────────────────────────────

test('rule 10: a conflict pair referencing a role no node binds → CONFLICT_REF_INVALID (warning)', () => {
  const t = localChange();
  t.policy = { conflicts: [['ghostRoleA', 'ghostRoleB']], enforcement: 'strict' };
  assertHasDiagnostic(t, 'CONFLICT_REF_INVALID');
});

test('rule 10: a malformed conflict entry (not a pair) → CONFLICT_REF_INVALID', () => {
  const t = localChange();
  (t.policy as unknown) = { conflicts: [['only-one']], enforcement: 'strict' };
  assertHasDiagnostic(t, 'CONFLICT_REF_INVALID');
});

// ─────────────────────────────────────────────────────────────────────────────
// Condition grammar — a malformed guard op is rejected (feeds rules 2/4/9).
// ─────────────────────────────────────────────────────────────────────────────

test('grammar: an unknown guard op → CONDITION_BAD_OP', () => {
  const t = template('inv')
    .entry('a')
    .domain('approved')
    .add(node.agent('a', 'role:x', 'router'), node.choice('router', [otherwise('end')]), node.terminal('end', 'succeeded'))
    .build();
  (t.nodes['router'] as { branches: unknown[] }).branches = [
    { when: { op: 'diff.changed', value: 'x' }, goto: 'end' }, // a deferred op, NOT in v1 grammar
    { default: 'end' },
  ];
  assertHasDiagnostic(t, 'CONDITION_BAD_OP');
});
