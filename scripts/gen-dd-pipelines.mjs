// One-shot generator: build a data-driven template_json for each e2e fixture pipeline using the
// pipeline-core builders, validate each via pipeline-core.validateTemplate, and write the result into
// src/e2e/fixtures/playbook/catalog/pipelines.json (execution_policy.template_json). Run via tsx.
//
// Not part of the build — a developer convenience to author + validate the slice-3 templates. Kept in
// scripts/ so the exact authored templates are reproducible/reviewable.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  template,
  node,
  on,
  otherwise,
  verdictEq,
  verdictIn,
  allOf,
  counterLt,
} from '../src/pipeline-core/kit/index.ts';
import { validateTemplate } from '../src/pipeline-core/index.ts';

const CATALOG = new URL('../src/e2e/fixtures/playbook/catalog/pipelines.json', import.meta.url);

// ── shared node fragments ─────────────────────────────────────────────────────

const integratorCatch = [
  { onError: 'revo.ScriptBlocked', goto: 'blockedEnd' },
  { onError: 'revo.ScriptFailed', goto: 'failedEnd' },
];

/** integrator script node (real-vs-stub resolved by the runner binding). */
const integratorNode = (next) =>
  node.script('integrator', 'script:integrator', next, {
    resultSchema: 'schema:integration',
    onFailure: 'route',
    catch: integratorCatch,
  });

/** Post-integrator status agent + its router + the bounded watcher-rework loop (re-integrates). */
function watcherCluster(statusRoleRef, mergeGoto) {
  return [
    node.agent('watcherPost', statusRoleRef, 'watcherRouter', { resultSchema: 'schema:watchVerdict', onFailure: 'abort' }),
    node.choice('watcherRouter', [
      on(verdictIn('approved', 'clean'), mergeGoto),
      on(allOf(verdictIn('blocker', 'changes_requested'), counterLt('watcherLoop', 3)), 'watcherRework'),
      otherwise('blockedEnd'),
    ]),
    node.agent('watcherRework', 'role:developer', 'integrator', {
      resultSchema: 'schema:change',
      incrementCounters: ['watcherLoop'],
      onFailure: 'abort',
    }),
  ];
}

// ── one template per fixture pipeline ──────────────────────────────────────────

function analysisOnly() {
  return template('analysis-only')
    .title('Analysis only — analyst, no edits, no gate')
    .entry('analyst')
    .domain('approved')
    .add(
      node.agent('analyst', 'role:analyst', 'analystRouter', { resultSchema: 'schema:plan', onFailure: 'abort' }),
      node.choice('analystRouter', [on(verdictEq('approved'), 'doneEnd'), otherwise('blockedEnd')]),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

function localChange() {
  return template('local-change')
    .title('Local change — developer only, no gate')
    .entry('developer')
    .domain('approved')
    .add(
      node.agent('developer', 'role:developer', 'doneEnd', { resultSchema: 'schema:change', onFailure: 'abort' }),
      node.terminal('doneEnd', 'succeeded'),
    )
    .build();
}

function methodDevelopment() {
  return template('method-development')
    .title('Method development — knowledge-engineer, no integrator (merge gate inert)')
    .entry('ke')
    .domain('approved')
    .add(
      node.agent('ke', 'role:knowledge-engineer', 'doneEnd', { resultSchema: 'schema:change', onFailure: 'abort' }),
      node.terminal('doneEnd', 'succeeded'),
    )
    .build();
}

function postMergeQa() {
  return template('post-merge-qa')
    .title('Post-merge QA — deploy-watcher → qa, no integrator, no gate')
    .entry('deployWatcher')
    .domain('approved')
    .add(
      node.agent('deployWatcher', 'role:deploy-watcher', 'qa', { resultSchema: 'schema:watchVerdict', onFailure: 'abort' }),
      node.agent('qa', 'role:qa-backend', 'qaRouter', { resultSchema: 'schema:watchVerdict', onFailure: 'abort' }),
      node.choice('qaRouter', [on(verdictEq('approved'), 'doneEnd'), otherwise('blockedEnd')]),
      node.terminal('doneEnd', 'succeeded'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

function bugfix() {
  return template('bugfix')
    .title('Bugfix — analyst → developer → integrate → watcher loop → merge gate (no plan gate, no code review)')
    .entry('analyst')
    .domain('approved', 'clean', 'blocker', 'changes_requested')
    .scope('watcherLoop', { cap: 3, parent: null })
    .add(
      node.agent('analyst', 'role:analyst', 'developer', { resultSchema: 'schema:plan', onFailure: 'abort' }),
      node.agent('developer', 'role:developer', 'integrator', { resultSchema: 'schema:change', onFailure: 'abort' }),
      integratorNode('watcherPost'),
      ...watcherCluster('role:watcher', 'mergeGate'),
      node.humanGate('mergeGate', 'merge-review', ['approved'], [
        on(verdictEq('approved'), 'mergedEnd'),
        otherwise('mergedEnd'), // merge reject completes the run (does not cancel) — B4 parity
      ]),
      node.terminal('mergedEnd', 'succeeded'),
      node.terminal('failedEnd', 'failed'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

/** The shared feature shape: analyst → planReviewer → planGate → developer → codeReview loop →
 *  integrate → <statusRole> watcher loop → mergeGate. `statusRoleRef` is the post-integrator role. */
function featureShape(pipelineId, statusRoleRef, title) {
  return template(pipelineId)
    .title(title)
    .entry('analyst')
    .domain('approved', 'clean', 'blocker', 'changes_requested')
    .policy({ conflicts: [['developer', 'reviewer']], enforcement: 'strict' })
    .scope('codeReviewLoop', { cap: 3, parent: null })
    .scope('watcherLoop', { cap: 3, parent: null })
    .add(
      node.agent('analyst', 'role:analyst', 'planReviewer', { resultSchema: 'schema:plan', onFailure: 'abort' }),
      node.agent('planReviewer', 'role:reviewer', 'planGate', { resultSchema: 'schema:reviewVerdict', onFailure: 'abort' }),
      node.humanGate('planGate', 'plan-review', ['approved'], [
        on(verdictEq('approved'), 'developer'),
        otherwise('blockedEnd'), // plan reject → blocked terminal (data-routed; was hard-cancel pre-0015)
      ]),
      node.agent('developer', 'role:developer', 'codeReview', { resultSchema: 'schema:change', onFailure: 'abort' }),
      node.agent('codeReview', 'role:reviewer', 'codeReviewRouter', { resultSchema: 'schema:reviewVerdict', onFailure: 'abort' }),
      node.choice('codeReviewRouter', [
        on(verdictIn('approved', 'clean'), 'integrator'),
        on(allOf(verdictIn('blocker', 'changes_requested'), counterLt('codeReviewLoop', 3)), 'reworkDeveloper'),
        otherwise('blockedEnd'),
      ]),
      node.agent('reworkDeveloper', 'role:developer', 'codeReview', {
        resultSchema: 'schema:change',
        incrementCounters: ['codeReviewLoop'],
        onFailure: 'abort',
      }),
      integratorNode('watcherPost'),
      ...watcherCluster(statusRoleRef, 'mergeGate'),
      node.humanGate('mergeGate', 'merge-review', ['approved'], [
        on(verdictEq('approved'), 'mergedEnd'),
        otherwise('mergedEnd'), // merge reject completes the run (does not cancel) — B4 parity
      ]),
      node.terminal('mergedEnd', 'succeeded'),
      node.terminal('failedEnd', 'failed'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

const TEMPLATES = {
  'analysis-only': analysisOnly(),
  bugfix: bugfix(),
  'feature-development': featureShape(
    'feature-development',
    'role:watcher',
    'Feature development — plan + merge gates, bounded code-review + watcher rework',
  ),
  'local-change': localChange(),
  'method-development': methodDevelopment(),
  'post-merge-qa': postMergeQa(),
  'feature-pr-watch': featureShape(
    'feature-pr-watch',
    'role:pr-watcher',
    'Feature PR watch — feature shape with an embedded pr-watcher post-integrator',
  ),
  'feature-pr-poll': featureShape(
    'feature-pr-poll',
    'role:pr-poller',
    'Feature PR poll — feature shape with an embedded (unknown-id, kind:status) pr-poller post-integrator',
  ),
};

// ── validate every template (errors only — warnings like declared-unused are tolerated) ──

let bad = 0;
for (const [id, tpl] of Object.entries(TEMPLATES)) {
  const diags = validateTemplate(tpl);
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    bad++;
    console.error(`✗ ${id}: ${errors.map((d) => `${d.code}${d.nodeId ? `@${d.nodeId}` : ''}`).join(', ')}`);
  } else {
    const warns = diags.filter((d) => d.severity === 'warning');
    console.log(`✓ ${id}${warns.length ? ` (warnings: ${warns.map((d) => d.code).join(', ')})` : ''}`);
  }
}
if (bad > 0) {
  console.error(`\n${bad} template(s) failed validation — NOT writing pipelines.json`);
  process.exit(1);
}

// ── merge template_json into the existing pipelines.json ───────────────────────

const pipelines = JSON.parse(readFileSync(CATALOG, 'utf8'));
for (const p of pipelines) {
  const tpl = TEMPLATES[p.id];
  if (!tpl) continue; // leave feature-development-dd (already data-driven) untouched
  p.execution_policy = p.execution_policy ?? {};
  p.execution_policy.template_json = tpl;
}
writeFileSync(CATALOG, JSON.stringify(pipelines, null, 2) + '\n', 'utf8');
console.log(`\nwrote template_json into ${pipelines.filter((p) => TEMPLATES[p.id]).length} pipelines`);
