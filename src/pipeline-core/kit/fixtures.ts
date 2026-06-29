






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
  verdictIn,
} from './builders.js';
import type { Branch, CatchEntry, ConsumesRef, Template } from '../types.js';

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
        on(allOf(verdictIn('blocker', 'changes_requested'), counterLt('codeReviewLoop', 3)), 'reworkDeveloper'),
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





export function confirmMergeFlow(): Template {
  return template('confirm-merge-flow')
    .title('confirmMerge → merged (succeeded) / not-merged (blocked) — plan 0017 test fixture')
    .specVersion('1.0')
    .entry('confirmMerge')
    .domain('approved', 'clean', 'blocker', 'changes_requested')
    .add(
      node.script('confirmMerge', 'script:confirmMerge', 'cleanupWorktree', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        catch: [
          { onError: 'revo.ScriptBlocked', goto: 'blockedEnd' },
          { onError: 'revo.ScriptFailed', goto: 'failedEnd' },
        ],
      }),
      node.script('cleanupWorktree', 'script:cleanupWorktree', 'mergedEnd', {
        resultSchema: 'schema:integration',
      }),
      node.terminal('mergedEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
      node.terminal('failedEnd', 'failed'),
    )
    .build();
}

function blockedOrFailedCatch(): CatchEntry[] {
  return [
    { onError: 'revo.ScriptBlocked', goto: 'blockedEnd' },
    { onError: 'revo.ScriptFailed', goto: 'failedEnd' },
  ];
}

function prReadinessScript(id: 'pollPr' | 'mergeReadiness', next: 'prRouter' | 'mergeReadinessRouter') {
  return node.script(id, 'script:pollPr', next, {
    resultSchema: 'schema:prFeedback',
    onFailure: 'route',
    produces: { name: 'prFeedback' },
    catch: blockedOrFailedCatch(),
  });
}

function prReadinessBranches(cleanGoto: 'mergeReadiness' | 'mergeGate'): Branch[] {
  return [
    on(verdictEq('clean'), cleanGoto),
    on(verdictEq('review_changes'), 'triage'),
    on(allOf(verdictEq('ci_changes'), counterLt('ciLoop', 3)), 'ciRework'),
    otherwise('blockedEnd'),
  ];
}

function freshMergeFeedbackConsume(): ConsumesRef {
  return { node: 'mergeReadiness', as: 'mergeFeedback', optional: true, staleOk: true };
}

function prFeedbackConsumes(): ConsumesRef[] {
  return [
    { node: 'pollPr', as: 'feedback' },
    freshMergeFeedbackConsume(),
  ];
}







export function featureDevelopmentPrReview(): Template {
  return template('feature-development-pr-review')
    .title('Feature development with a PR review-feedback loop (plan 0018)')
    .specVersion('1.0')
    .entry('analyst')
    .domain('approved', 'changes_requested', 'blocker', 'clean', 'review_changes', 'ci_changes', 'fix', 'wontfix', 'question')
    .policy({ conflicts: [['developer', 'reviewer']], enforcement: 'strict' })
    .scope('codeReviewLoop', { cap: 3, parent: null })
    .scope('ciLoop', { cap: 3, parent: null })
    .scope('reviewLoop', { cap: 3, parent: null })
    .scope('questionLoop', { cap: 3, parent: null })
    .add(
      node.agent('analyst', 'role:analyst', 'planGate', { resultSchema: 'schema:plan', onFailure: 'abort', produces: { name: 'plan' } }),
      node.humanGate('planGate', 'plan-review', ['approved', 'changes_requested'], [
        on(verdictEq('approved'), 'developer'),
        on(verdictEq('changes_requested'), 'analyst'),
        otherwise('blockedEnd'),
      ]),
      node.agent('developer', 'role:developer', 'codeReview', {
        resultSchema: 'schema:change',
        onFailure: 'abort',
        produces: { name: 'change' },
      }),
      node.agent('codeReview', 'role:reviewer', 'codeReviewRouter', {
        resultSchema: 'schema:reviewVerdict',
        onFailure: 'abort',
        consumes: [
          { node: 'developer', as: 'developerChange', staleOk: true },
          { node: 'reworkDeveloper', as: 'reworkChange', optional: true },
        ],
      }),
      node.choice('codeReviewRouter', [
        on(verdictEq('approved'), 'integrator'),
        on(allOf(verdictIn('blocker', 'changes_requested'), counterLt('codeReviewLoop', 3)), 'reworkDeveloper'),
        otherwise('blockedEnd'),
      ]),
      node.agent('reworkDeveloper', 'role:developer', 'codeReview', {
        resultSchema: 'schema:change',
        incrementCounters: ['codeReviewLoop'],
        onFailure: 'abort',
        produces: { name: 'change' },
      }),
      node.script('integrator', 'script:integrator', 'pollPr', {
        resultSchema: 'schema:integration', onFailure: 'route',
        consumes: [
          { node: 'developer', as: 'developerChange', staleOk: true },
          { node: 'reworkDeveloper', as: 'reworkChange', optional: true },
          { node: 'ciRework', as: 'ciChange', optional: true, staleOk: true },
        ],
        catch: [{ onError: 'revo.ScriptFailed', goto: 'failedEnd' }],
      }),
      prReadinessScript('pollPr', 'prRouter'),
      node.choice('prRouter', prReadinessBranches('mergeReadiness')),
      prReadinessScript('mergeReadiness', 'mergeReadinessRouter'),
      node.choice('mergeReadinessRouter', prReadinessBranches('mergeGate')),
      node.agent('ciRework', 'role:developer', 'integrator', {
        resultSchema: 'schema:change', incrementCounters: ['ciLoop'], onFailure: 'abort',
        produces: { name: 'change' },
        consumes: prFeedbackConsumes(),
      }),
      node.agent('triage', 'role:triager', 'triageRouter', {
        resultSchema: 'schema:triage', onFailure: 'abort', produces: { name: 'triage' },
        consumes: [
          { node: 'analyst', as: 'plan', staleOk: true },
          ...prFeedbackConsumes(),
        ],
      }),
      node.choice('triageRouter', [
        on(allOf(verdictEq('question'), counterLt('questionLoop', 3)), 'questionGate'),
        on(allOf(verdictEq('fix'), counterLt('reviewLoop', 3)), 'reviewRework'),
        on(verdictEq('wontfix'), 'respondThreads'),
        otherwise('blockedEnd'),
      ]),
      node.humanGate('questionGate', 'review-question', ['approved', 'changes_requested'], [
        on(verdictEq('approved'), 'triage'),
        otherwise('blockedEnd'),
      ], { incrementCounters: ['questionLoop'] }),
      node.agent('reviewRework', 'role:developer', 'reviewIntegrator', {
        resultSchema: 'schema:change', incrementCounters: ['reviewLoop'], onFailure: 'abort',
        produces: { name: 'change' },
        consumes: [{ node: 'triage', as: 'triage' }],
      }),
      node.script('reviewIntegrator', 'script:integrator', 'respondThreads', {
        resultSchema: 'schema:integration', onFailure: 'route',
        consumes: [{ node: 'reviewRework', as: 'reviewChange' }],
        catch: blockedOrFailedCatch(),
      }),
      node.script('respondThreads', 'script:respondThreads', 'pollPr', {
        resultSchema: 'schema:respond', onFailure: 'route', consumes: [{ node: 'triage', as: 'triage' }],
        catch: blockedOrFailedCatch(),
      }),
      node.humanGate('mergeGate', 'merge-review', ['approved', 'changes_requested'], [
        on(verdictEq('approved'), 'confirmMerge'),
        otherwise('blockedEnd'),
      ], { gatedArtifact: { node: 'mergeReadiness', as: 'prFeedback' } }),
      node.script('confirmMerge', 'script:confirmMerge', 'mergedEnd', {
        resultSchema: 'schema:integration', onFailure: 'route',
        consumes: [{ node: 'mergeReadiness', as: 'mergeReadiness' }],
        catch: blockedOrFailedCatch(),
      }),
      node.terminal('mergedEnd', 'succeeded'),
      node.terminal('failedEnd', 'failed'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

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


function joinModeFromKind(kind: 'all' | 'any' | 'quorum') {
  if (kind === 'all') return joinAll();
  if (kind === 'any') return joinAny();
  return joinQuorum(2);
}


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
      node.join('reviewJoin', mode, 'joinRouter', { merge: { findings: 'appendByBranchOrder' } }),
      node.choice('joinRouter', [on(verdictEq('clean'), 'doneEnd'), otherwise('blockedEnd')]),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

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


export const invalidEntryUnresolved = (): Template =>
  template('inv').entry('ghost').domain('approved').add(node.terminal('end', 'succeeded')).build();


export const invalidRefUnresolved = (): Template =>
  template('inv').entry('a').domain('approved').add(node.agent('a', 'role:x', 'nowhere')).build();


export const invalidNonterminalNoExit = (): Template =>
  template('inv').entry('a').domain('approved').add(node.choice('a', [])).build();


export const invalidTerminalBadStatus = (): Template => {
  const t = template('inv').entry('a').domain('approved').add(node.terminal('a', 'succeeded')).build();
  (t.nodes['a'] as { status: string }).status = 'done';
  return t;
};


export const invalidNoDefault = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.choice('a', [on(verdictEq('approved'), 'end')]), node.terminal('end', 'succeeded'))
    .build();


export const invalidGuardAfterDefault = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(
      node.choice('a', [otherwise('end'), on(verdictEq('approved'), 'end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();


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


export const invalidCrossBranchGoto = (): Template =>
  template('inv')
    .entry('fanout')
    .domain('clean')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aWork' }, { id: 'b', entry: 'bWork' }], 'j'),
      node.agent('aWork', 'role:x', 'bWork'),
      node.agent('bWork', 'role:y', 'j'),
      node.join('j', joinAll(), 'end', { merge: { f: 'overwrite' } }),
      node.terminal('end', 'succeeded'),
    )
    .build();


export const invalidMissingMerge = (): Template =>
  template('inv')
    .entry('fanout')
    .domain('clean')
    .add(
      node.parallel('fanout', [{ id: 'a', entry: 'aWork' }, { id: 'b', entry: 'bWork' }], 'j'),
      node.agent('aWork', 'role:x', 'j'),
      node.agent('bWork', 'role:y', 'j'),
      node.join('j', joinAll(), 'end'),
      node.terminal('end', 'succeeded'),
    )
    .build();


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


export const invalidDomainShadowsCore = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved', 'failed')
    .add(node.agent('a', 'role:x', 'end'), node.terminal('end', 'succeeded'))
    .build();


export const invalidGateOutcomeNotSubset = (): Template =>
  template('inv')
    .entry('g')
    .domain('approved')
    .add(
      node.humanGate('g', 'r', ['approved', 'rejected'], [on(verdictEq('approved'), 'end'), otherwise('end')]),
      node.terminal('end', 'succeeded'),
    )
    .build();


export const invalidBadId = (): Template => {
  const t = template('inv').entry('a').domain('approved').add(node.agent('a', 'role:x', 'end'), node.terminal('end', 'succeeded')).build();
  const a = t.nodes['a'];
  delete t.nodes['a'];
  (a as { id: string }).id = '1bad';
  t.nodes['1bad'] = a;
  t.entry = '1bad';
  return t;
};


export const invalidCapabilityRef = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.agent('a', 'not-a-role-handle', 'end'), node.terminal('end', 'succeeded'))
    .build();


export const invalidRouteNoCatch = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.script('a', 'script:x', 'end', { onFailure: 'route' }), node.terminal('end', 'succeeded'))
    .build();


export const invalidEscalateNoTarget = (): Template =>
  template('inv')
    .entry('a')
    .domain('approved')
    .add(node.agent('a', 'role:x', 'end', { onFailure: 'escalate' }), node.terminal('end', 'succeeded'))
    .build();
