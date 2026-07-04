/**
 * validate.test.ts — the §12 validation rule catalogue.
 *
 * Reads as a rule-by-rule spec: each test names a §12 rule, drives a minimal fixture that violates it,
 * and asserts the expected diagnostic code (kit `assertHasDiagnostic`/`assertDiagnostics`). The two
 * real pipelines (§13 + footnote) and the targeted valid fixtures must produce NO errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTemplate } from './validate.js';
import type { ConsumesRef, DiagnosticCode, Template } from './types.js';
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
  allOf,
  anyOf,
  counterGte,
  counterLt,
  joinAll,
  localChange,
  nestedScopeLoop,
  node,
  notCond,
  on,
  otherwise,
  parallelReview,
  template,
  verdictEq,
  verdictIn,
} from './kit/index.js';

type PipelineCatalogEntry = {
  id: string;
  execution_policy?: { template_json?: Template };
};

function bundledFeatureDevelopment(): Template {
  const pipelines = JSON.parse(
    readFileSync(new URL('../../control-plane/default-playbook/catalog/pipelines.json', import.meta.url), 'utf8'),
  ) as PipelineCatalogEntry[];
  const templateJson = pipelines.find((pipeline) => pipeline.id === 'feature-development')
    ?.execution_policy?.template_json;
  assert.ok(templateJson, 'bundled feature-development template_json exists');
  return templateJson;
}

function bundledWarningSites(code: DiagnosticCode): string[] {
  return validateTemplate(bundledFeatureDevelopment())
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => {
      assert.equal(diagnostic.severity, 'warning', `${code} stays at warning severity`);
      return diagnostic.path ? `${diagnostic.nodeId}:${diagnostic.path}` : (diagnostic.nodeId ?? '');
    })
    .sort();
}

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

test('rule 7: a counter loop may wrap fan-out when branch bodies do not touch that scope', () => {
  const t = template('valid')
    .specVersion('1.0')
    .entry('fanout')
    .domain('again', 'done')
    .scope('L', { cap: 2, parent: null })
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aw' }, { id: 'b', entry: 'bw' }], 'j'),
      node.agent('aw', 'role:y', 'j'),
      node.agent('bw', 'role:z', 'j'),
      node.join('j', joinAll(), 'router', { merge: { f: 'overwrite' } }),
      node.choice('router', [on(counterLt('L', 2), 'fanout'), otherwise('doneEnd')], {
        incrementCounters: ['L'],
      }),
      node.terminal('doneEnd', 'succeeded'),
    )
    .build();
  assertValid(t);
});

test('rule 7: a counter used inside a fan-out branch and read after the join → SCOPE_SPANS_PARALLEL', () => {
  const t = template('inv')
    .specVersion('1.0')
    .entry('fanout')
    .domain('again', 'done')
    .scope('L', { cap: 2, parent: null })
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aw' }, { id: 'b', entry: 'bw' }], 'j'),
      node.agent('aw', 'role:y', 'j', { incrementCounters: ['L'] }),
      node.agent('bw', 'role:z', 'j'),
      node.join('j', joinAll(), 'router', { merge: { f: 'overwrite' } }),
      node.choice('router', [on(counterLt('L', 2), 'fanout'), otherwise('doneEnd')]),
      node.terminal('doneEnd', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'SCOPE_SPANS_PARALLEL');
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

test('rule 8: a branch that can terminate before its join → BRANCH_TERMINAL_BEFORE_JOIN', () => {
  const t = template('inv')
    .entry('fanout')
    .domain('approved')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aw' }, { id: 'b', entry: 'bw' }], 'j'),
      node.choice('aw', [on(verdictEq('approved'), 'j'), otherwise('earlyEnd')]),
      node.agent('bw', 'role:y', 'j'),
      node.join('j', joinAll(), 'end', { merge: { f: 'overwrite' } }),
      node.terminal('earlyEnd', 'blocked'),
      node.terminal('end', 'succeeded'),
    )
    .build();

  assertHasDiagnostic(t, 'BRANCH_TERMINAL_BEFORE_JOIN');
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

test('rule 9: a join verdictReducer label outside domain → VERDICT_UNDECLARED', () => {
  const t = parallelReview('all');
  (t.nodes['reviewJoin'] as {
    verdictReducer?: { kind: 'allIn'; pass: string[]; passVerdict: string; failVerdict: string };
  }).verdictReducer = {
    kind: 'allIn',
    pass: ['clean'],
    passVerdict: 'approved',
    failVerdict: 'changes_requested',
  };
  assertHasDiagnostic(t, 'VERDICT_UNDECLARED');
});

test('rule 9: a join verdictReducer with an unknown kind → VERDICT_REDUCER_BAD_KIND', () => {
  const t = parallelReview('all');
  (t.nodes['reviewJoin'] as { verdictReducer?: unknown }).verdictReducer = {
    kind: 'some',
    pass: ['clean'],
    passVerdict: 'clean',
    failVerdict: 'dirty',
  };
  assertHasDiagnostic(t, 'VERDICT_REDUCER_BAD_KIND');
});

test('rule 9: a malformed join verdictReducer allIn shape → VERDICT_REDUCER_BAD_SHAPE', () => {
  const t = parallelReview('all');
  (t.nodes['reviewJoin'] as { verdictReducer?: unknown }).verdictReducer = {
    kind: 'allIn',
    pass: 'clean',
    passVerdict: 'clean',
    failVerdict: 'dirty',
  };
  assertHasDiagnostic(t, 'VERDICT_REDUCER_BAD_SHAPE');
});

test('rule 9: a declared-but-unused domain label → VERDICT_DECLARED_UNUSED (warning)', () => {
  const diags = validateTemplate(featureDevelopment());
  const unused = diags.find((d) => d.code === 'VERDICT_DECLARED_UNUSED');
  assert.ok(unused, 'feature-development declares `dirty`/`clean` etc.; an unused one warns');
  assert.equal(unused.severity, 'warning');
});

test('warning: GATE_OUTCOME_UNROUTED fires on current bundled default template', () => {
  assert.deepEqual(bundledWarningSites('GATE_OUTCOME_UNROUTED'), [
    'questionGate:outcomes.changes_requested',
    'recoveryGate:outcomes.approved',
  ]);
});

test('warning: CYCLE_WITHOUT_COUNTER fires on current bundled default template', () => {
  assert.deepEqual(bundledWarningSites('CYCLE_WITHOUT_COUNTER'), [
    'mergeReadinessRouter',
    'prRouter',
  ]);
});

test('warning: CYCLE_WITHOUT_COUNTER ignores counter reads on unrelated exit branches', () => {
  const t = template('unrelated-counter-bound')
    .entry('poll')
    .domain('cancel', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(verdictEq('recheck'), 'poll'),
        on(counterGte('rechecks', 3), 'manualGate'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(diags.some((diag) => diag.code === 'CYCLE_WITHOUT_COUNTER' && diag.nodeId === 'router'));
});

test('warning: CYCLE_WITHOUT_COUNTER accepts a counter exit branch before the loop branch', () => {
  const t = template('preemptive-counter-bound')
    .entry('poll')
    .domain('cancel', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(counterGte('rechecks', 3), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  assertNoDiagnostic(t, 'CYCLE_WITHOUT_COUNTER');
});

test('warning: CYCLE_WITHOUT_COUNTER ignores unrelated cycle branches before a counter exit', () => {
  const t = template('unrelated-cycle-branch-before-counter-bound')
    .entry('poll')
    .domain('cancel', 'other', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(verdictEq('other'), 'poll'),
        on(counterGte('rechecks', 3), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  assertNoDiagnostic(t, 'CYCLE_WITHOUT_COUNTER');
});

test('warning: CYCLE_WITHOUT_COUNTER accepts a disjunctive counter exit branch before the loop branch', () => {
  const t = template('disjunctive-counter-bound')
    .entry('poll')
    .domain('cancel', 'other', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(anyOf(verdictEq('other'), counterGte('rechecks', 3)), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  assertNoDiagnostic(t, 'CYCLE_WITHOUT_COUNTER');
});

test('warning: CYCLE_WITHOUT_COUNTER accepts a negated counter cap before the loop branch', () => {
  const t = template('negated-counter-bound')
    .entry('poll')
    .domain('cancel', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(notCond(counterLt('rechecks', 3)), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  assertNoDiagnostic(t, 'CYCLE_WITHOUT_COUNTER');
});

test('warning: CYCLE_WITHOUT_COUNTER warns for negated disjunctions impossible for recheck', () => {
  const t = template('negated-impossible-disjunctive-counter-bound')
    .entry('poll')
    .domain('cancel', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(notCond(anyOf(verdictEq('recheck'), counterGte('rechecks', 3))), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(diags.some((diag) => diag.code === 'CYCLE_WITHOUT_COUNTER' && diag.nodeId === 'router'));
});

test('warning: CYCLE_WITHOUT_COUNTER warns for negated complementary counter disjunctions', () => {
  const t = template('negated-complementary-counter-bound')
    .entry('poll')
    .domain('cancel', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(notCond(anyOf(counterGte('rechecks', 3), counterLt('rechecks', 3))), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(diags.some((diag) => diag.code === 'CYCLE_WITHOUT_COUNTER' && diag.nodeId === 'router'));
});

test('warning: CYCLE_WITHOUT_COUNTER warns for negated overlapping counter disjunctions', () => {
  const t = template('negated-overlapping-counter-bound')
    .entry('poll')
    .domain('cancel', 'recheck')
    .scope('rechecks', { cap: 4, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(notCond(anyOf(counterGte('rechecks', 3), counterLt('rechecks', 4))), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(diags.some((diag) => diag.code === 'CYCLE_WITHOUT_COUNTER' && diag.nodeId === 'router'));
});

test('warning: CYCLE_WITHOUT_COUNTER warns for conjunctive counter branches gated by unrelated verdicts', () => {
  const t = template('unrelated-verdict-counter-bound')
    .entry('poll')
    .domain('cancel', 'other', 'recheck')
    .scope('rechecks', { cap: 3, parent: null })
    .add(
      node.script('poll', 'script:pollPr', 'router', {
        incrementCounters: ['rechecks'],
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedEnd' }],
      }),
      node.choice('router', [
        on(allOf(verdictEq('other'), counterGte('rechecks', 3)), 'manualGate'),
        on(verdictEq('recheck'), 'poll'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('manualGate', 'review', ['cancel'], [
        on(verdictEq('cancel'), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('cancelledEnd', 'cancelled'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(diags.some((diag) => diag.code === 'CYCLE_WITHOUT_COUNTER' && diag.nodeId === 'router'));
});

test('warning: SCRIPT_FAILURE_UNROUTED fires on current bundled default template', () => {
  assert.deepEqual(bundledWarningSites('SCRIPT_FAILURE_UNROUTED'), ['cleanupWorktree']);
});

test('warning: HUMAN_OFFRAMP_UNREACHABLE fires on current bundled default template', () => {
  assert.deepEqual(bundledWarningSites('HUMAN_OFFRAMP_UNREACHABLE'), ['questionGate']);
});

test('warning: AGENT_FAILURE_UNROUTED fires on current bundled default template', () => {
  assert.deepEqual(bundledWarningSites('AGENT_FAILURE_UNROUTED'), [
    'analyst',
    'ciRework',
    'classifyRecovery',
    'codeReview',
    'developer',
    'planReviewer',
    'reviewRework',
    'reworkDeveloper',
    'stuckReworkDeveloper',
    'triage',
  ]);
});

test('warning: negated verdict equality does not count as explicit gate outcome routing', () => {
  const t = template('negated-outcome')
    .entry('gate')
    .domain('cancel')
    .add(
      node.humanGate('gate', 'review', ['cancel'], [
        on(notCond(verdictEq('cancel')), 'cancelledEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('cancelledEnd', 'cancelled'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(diags.some((diag) => diag.code === 'GATE_OUTCOME_UNROUTED' && diag.nodeId === 'gate' && diag.path === 'outcomes.cancel'));
  assert.ok(diags.some((diag) => diag.code === 'HUMAN_OFFRAMP_UNREACHABLE' && diag.nodeId === 'gate'));
});

test('warning: negated verdict set does not count as explicit gate outcome routing', () => {
  const t = template('negated-outcome-set')
    .entry('gate')
    .domain('changes_requested', 'approved')
    .add(
      node.humanGate('gate', 'review', ['changes_requested', 'approved'], [
        on(notCond(verdictIn('changes_requested')), 'approvedEnd'),
        on(verdictEq('approved'), 'approvedEnd'),
        otherwise('blockedEnd'),
      ]),
      node.terminal('approvedEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();

  const diags = validateTemplate(t);
  assert.ok(
    diags.some(
      (diag) => diag.code === 'GATE_OUTCOME_UNROUTED' && diag.nodeId === 'gate' && diag.path === 'outcomes.changes_requested',
    ),
  );
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

// ─────────────────────────────────────────────────────────────────────────────
// Rule 14 — dataflow (produces/consumes, 0016 §7).
// ─────────────────────────────────────────────────────────────────────────────

const dfDominated = () =>
  template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:analyst', 'b', { produces: { name: 'plan' } }),
      node.agent('b', 'role:developer', 'done', { consumes: [{ node: 'a', as: 'plan' }] }),
      node.terminal('done', 'succeeded'),
    )
    .build();

test('rule 14: a dominated consume produces no dataflow diagnostics', () => {
  const diags = validateTemplate(dfDominated());
  assert.deepEqual(
    diags.filter((d) => d.code.startsWith('CONSUMES') || d.code === 'PRODUCES_NAME_DUP'),
    [],
  );
});

test('rule 14: consuming an unknown node → CONSUMES_NODE_UNRESOLVED', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'done', { consumes: [{ node: 'ghost', as: 'p' }] }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'CONSUMES_NODE_UNRESOLVED');
});

test('rule 14: consuming a node with no produces → CONSUMES_PRODUCER_MISSING', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'b'),
      node.agent('b', 'role:y', 'done', { consumes: [{ node: 'a', as: 'p' }] }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'CONSUMES_PRODUCER_MISSING');
});

// D3 — humanGate gatedArtifact/verdictFrom ref validation.
const gateWithArtifact = (artifact: { node: string; as?: string }) =>
  template('gate-df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:analyst', 'g', { produces: { name: 'plan' } }),
      node.humanGate('g', 'plan-review', ['approved'], [on(verdictEq('approved'), 'done'), otherwise('done')], {
        gatedArtifact: artifact,
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();

test('D3: a gatedArtifact pointing at a producing node is valid (no diagnostic)', () => {
  assertNoDiagnostic(gateWithArtifact({ node: 'a', as: 'plan' }), 'GATE_REF_UNRESOLVED');
  assertNoDiagnostic(gateWithArtifact({ node: 'a', as: 'plan' }), 'GATE_ARTIFACT_NO_PRODUCES');
});

test('D3: gatedArtifact referencing an unknown node → GATE_REF_UNRESOLVED', () => {
  assertHasDiagnostic(gateWithArtifact({ node: 'ghost' }), 'GATE_REF_UNRESOLVED');
});

test('D3: gatedArtifact referencing a node with no produces → GATE_ARTIFACT_NO_PRODUCES', () => {
  const t = template('gate-df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'g'), // no produces
      node.humanGate('g', 'plan-review', ['approved'], [on(verdictEq('approved'), 'done'), otherwise('done')], {
        gatedArtifact: { node: 'a' },
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'GATE_ARTIFACT_NO_PRODUCES');
});

test('D3: verdictFrom referencing an unknown node → GATE_REF_UNRESOLVED', () => {
  const t = template('gate-df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:analyst', 'g', { produces: { name: 'plan' } }),
      node.humanGate('g', 'plan-review', ['approved'], [on(verdictEq('approved'), 'done'), otherwise('done')], {
        gatedArtifact: { node: 'a' },
        verdictFrom: { node: 'ghost' },
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'GATE_REF_UNRESOLVED');
});

const dfNotDominated = (optional: boolean) =>
  template('df')
    .specVersion('1.0')
    .entry('start')
    .domain('approved')
    .add(
      node.agent('start', 'role:x', 'c'),
      node.choice('c', [on(verdictEq('approved'), 'p'), otherwise('q')]),
      node.agent('p', 'role:y', 'm', { produces: { name: 'plan' } }),
      node.agent('q', 'role:z', 'm'),
      node.agent('m', 'role:w', 'done', { consumes: [{ node: 'p', as: 'plan', ...(optional ? { optional: true } : {}) }] }),
      node.terminal('done', 'succeeded'),
    )
    .build();

test('rule 14: a required consume whose producer is not on every path → CONSUMES_NOT_DOMINATED (error)', () => {
  assert.equal(assertHasDiagnostic(dfNotDominated(false), 'CONSUMES_NOT_DOMINATED').severity, 'error');
});

test('rule 14: the same non-dominated consume marked optional → CONSUMES_NOT_DOMINATED is a warning', () => {
  assert.equal(assertHasDiagnostic(dfNotDominated(true), 'CONSUMES_NOT_DOMINATED').severity, 'warning');
});

test('rule 14: duplicate `as` keys on one node → CONSUMES_AS_DUP', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'a2', { produces: { name: 'x' } }),
      node.agent('a2', 'role:y', 'm', { produces: { name: 'y' } }),
      node.agent('m', 'role:z', 'done', {
        consumes: [
          { node: 'a', as: 'p' },
          { node: 'a2', as: 'p' },
        ],
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'CONSUMES_AS_DUP');
});

test('rule 14: two nodes producing the same name → PRODUCES_NAME_DUP (warning)', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved')
    .add(
      node.agent('a', 'role:x', 'b', { produces: { name: 'plan' } }),
      node.agent('b', 'role:y', 'done', { produces: { name: 'plan' } }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assert.equal(assertHasDiagnostic(t, 'PRODUCES_NAME_DUP').severity, 'warning');
});

test('rule 14: a human gate and an effect node producing the same name → PRODUCES_NAME_DUP (warning)', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved', 'abort')
    .add(
      node.agent('a', 'role:x', 'g', { produces: { name: 'gateResolution' } }),
      node.humanGate(
        'g',
        'approval',
        ['approved', 'abort'],
        [on(verdictEq('approved'), 'done'), otherwise('done')],
        { produces: { name: 'gateResolution' } },
      ),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assert.equal(assertHasDiagnostic(t, 'PRODUCES_NAME_DUP').severity, 'warning');
});

const dfLoop = (ref: ConsumesRef) =>
  template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved', 'blocker')
    .scope('L', { cap: 2, parent: null })
    .add(
      node.agent('a', 'role:x', 'dev', { produces: { name: 'plan' } }),
      node.agent('dev', 'role:y', 'r'),
      node.choice('r', [on(allOf(verdictEq('blocker'), counterLt('L', 2)), 'rework'), otherwise('done')]),
      node.agent('rework', 'role:z', 'dev', { consumes: [ref], incrementCounters: ['L'] }),
      node.terminal('done', 'succeeded'),
    )
    .build();

test('rule 14: a consumer in a loop the producer is not on → CONSUMES_STALE_RISK (warning)', () => {
  assert.equal(assertHasDiagnostic(dfLoop({ node: 'a', as: 'plan' }), 'CONSUMES_STALE_RISK').severity, 'warning');
});

test('rule 14: staleOk suppresses CONSUMES_STALE_RISK', () => {
  assertNoDiagnostic(dfLoop({ node: 'a', as: 'plan', staleOk: true }), 'CONSUMES_STALE_RISK');
});

test('rule 14: iteration:all suppresses CONSUMES_STALE_RISK', () => {
  assertNoDiagnostic(dfLoop({ node: 'a', as: 'plan', iteration: 'all' }), 'CONSUMES_STALE_RISK');
});

test('rule 14: a producer inside the same loop is fresh (no stale risk, dominated)', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('a')
    .domain('approved', 'blocker')
    .scope('L', { cap: 2, parent: null })
    .add(
      node.agent('a', 'role:x', 'cr'),
      node.agent('cr', 'role:r', 'router', { produces: { name: 'review' } }),
      node.choice('router', [on(allOf(verdictEq('blocker'), counterLt('L', 2)), 'rework'), otherwise('done')]),
      node.agent('rework', 'role:z', 'cr', { consumes: [{ node: 'cr', as: 'review' }], incrementCounters: ['L'] }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertNoDiagnostic(t, 'CONSUMES_STALE_RISK');
  assertNoDiagnostic(t, 'CONSUMES_NOT_DOMINATED');
});

test('rule 14: consuming a sibling parallel branch → CONSUMES_CROSS_PARALLEL_UNSAFE', () => {
  const t = template('df')
    .specVersion('1.0')
    .entry('fork')
    .domain('approved')
    .add(
      node.parallel('fork', [
        { id: 'b1', entry: 'p1' },
        { id: 'b2', entry: 'p2' },
      ], 'j'),
      node.agent('p1', 'role:x', 'j', { produces: { name: 'plan' } }),
      node.agent('p2', 'role:y', 'j', { consumes: [{ node: 'p1', as: 'plan' }] }),
      node.join('j', joinAll(), 'done'),
      node.terminal('done', 'succeeded'),
    )
    .build();
  assertHasDiagnostic(t, 'CONSUMES_CROSS_PARALLEL_UNSAFE');
});
