/**
 * Unit tests for the DATA-DRIVEN DBOS effect-adapter, exercising the PRODUCTION builder
 * (`makeDataDrivenTask`) directly with fakes — no DBOS, no Revisium (the C1 pattern). PipelineService
 * registers this exact builder, so these tests fail if the adapter's core.step loop, capability
 * resolution, gate mapping, terminal handling, or failure routing regresses.
 *
 * The pure pipeline-core graph is fixed (`featureDevelopment` fixture); the adapter is the unit under
 * test. We script the `runStepFn` per node id and assert which terminal the run reaches + which gates
 * opened, plus that the integrator script + completion verbs were invoked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDataDrivenTask, type DataDrivenTaskDeps } from './data-driven-task.workflow.js';
import { templateFromExecutionPolicy } from './data-driven-template.js';
import { featureDevelopment } from '../pipeline-core/kit/fixtures.js';
import type { Template } from '../pipeline-core/index.js';
import type { AttemptResult } from '../worker/runner.js';
import type { RouteDecision, RouteRoleBinding } from './route-contract.js';
import type { Decision as GateDecision } from './await-human.js';
import type { IntegratorInput, IntegratorOutput } from '../runners/integrator.js';

const RUN_ID = 'run-dd-001';

function binding(roleId: string, resolvedRunnerId = 'script'): RouteRoleBinding {
  return { roleId, rowId: roleId, modelLevel: 'standard', runnerId: 'claude-code', resolvedRunnerId, runnerSource: 'playbook' };
}

/** A route binding the data-driven feature template's roleRefs/scriptRef resolve against. */
function makeRoute(): RouteDecision {
  return {
    playbookId: 'pb',
    pipelineId: 'feature-development-dd',
    pipelineRowId: 'row',
    source: 'explicit',
    roles: ['analyst', 'developer', 'reviewer', 'integrator', 'watcher'],
    requiredRoles: ['analyst', 'developer', 'reviewer', 'integrator', 'watcher'],
    optionalRoles: [],
    routeGates: ['plan', 'merge'],
    executionPolicy: {},
    executionProfile: { id: 'test', runnerOverrides: {} },
    roleBindings: [
      binding('analyst'),
      binding('developer'),
      binding('reviewer'),
      binding('integrator', 'revo-integrator'), // real-integrator runner → script:integrator resolves here
      binding('watcher'),
    ],
    params: {},
  };
}

type Recorder = {
  gates: string[];
  completed: Array<{ verdict?: string }>;
  blocked: Array<{ reason?: string }>;
  failed: string[];
  integrateCalls: number;
  events: string[];
};

/**
 * Build the adapter from a per-node verdict script + a gate decider. `runStepFn` returns the scripted
 * domain verdict for the node id; an absent entry returns a structural PASS-equivalent with no verdict.
 */
function buildAdapter(opts: {
  verdicts?: Record<string, string | string[]>;
  gate?: (topic: 'plan' | 'merge') => GateDecision;
  needsHumanNodes?: Set<string>;
  template?: Template;
}) {
  const rec: Recorder = { gates: [], completed: [], blocked: [], failed: [], integrateCalls: 0, events: [] };
  const visits = new Map<string, number>();

  const runStepFn = async (
    _runId: string,
    _role: string,
    stepKey: string,
    _input: unknown,
  ): Promise<AttemptResult> => {
    const n = visits.get(stepKey) ?? 0;
    visits.set(stepKey, n + 1);
    if (opts.needsHumanNodes?.has(stepKey)) {
      return { output: { verdict: 'BLOCKER' }, nextSteps: [], costs: [], needsHuman: true, lesson: 'parked' };
    }
    const entry = opts.verdicts?.[stepKey];
    const verdict = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] ?? 'approved') : (entry ?? 'approved');
    return { output: { verdict }, nextSteps: [], costs: [] };
  };

  const deps: DataDrivenTaskDeps = {
    appendEvent: async (e) => { rec.events.push(`${e.type}:${e.stepKey}`); },
    awaitHuman: async (_runId, topic): Promise<GateDecision> => {
      rec.gates.push(topic);
      return (opts.gate ?? (() => ({ decision: 'approve' })))(topic);
    },
    completeRun: async (_runId, o) => { rec.completed.push({ verdict: o?.verdict }); return null; },
    failRun: async (_runId, reason) => { rec.failed.push(reason); return null; },
    blockRun: async (_runId, o) => { rec.blocked.push({ reason: o?.reason }); return null; },
    loadRunTaskContext: async () => ({ taskId: 'task-1', title: 'T', base: 'master', repoRef: '' }),
    integrateFn: async (input: IntegratorInput): Promise<IntegratorOutput> => {
      rec.integrateCalls++;
      return { prUrl: `https://example/pr/${input.taskId}`, branch: 'feat/x', prNumber: 1 };
    },
    runStub: (input: IntegratorInput): IntegratorOutput => {
      rec.integrateCalls++;
      return { prUrl: 'stub://pr/placeholder', branch: `feat/${input.taskId}-stub`, prNumber: 0 };
    },
  };

  const fn = makeDataDrivenTask(runStepFn, deps);
  const template = opts.template ?? featureDevelopment();
  return { run: () => fn(RUN_ID, { route: makeRoute(), template }), rec };
}

test('DD1: happy path — analyst→plan→developer→review→integrate→watcher(clean)→merge → succeeded', async () => {
  const { run, rec } = buildAdapter({
    verdicts: { codeReview: 'approved', watcherPost: 'clean' },
    gate: () => ({ decision: 'approve' }),
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['plan', 'merge'], 'both humanGate nodes opened, in order');
  assert.equal(rec.completed.length, 1, 'completeRun called once');
  assert.equal(rec.integrateCalls, 1, 'the integrator script ran once (real integrator via runner-wins)');
  assert.ok(rec.events.includes('integrate_succeeded:integrator'), 'integrate_succeeded emitted at the script node');
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
});

test('DD2: reviewer BLOCKER ×cap → bounded rework loop → blocked terminal (counter cap is DATA)', async () => {
  const { run, rec } = buildAdapter({
    // codeReview always blocker → codeReviewRouter loops to reworkDeveloper until counter.gte(3) → blockedEnd.
    verdicts: { codeReview: 'blocker' },
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'the run blocks at the cap, not the agent');
  assert.equal(rec.completed.length, 0);
  assert.equal(rec.blocked.length, 1, 'blockRun called once');
  assert.equal(rec.gates.length, 1, 'only the plan gate opened (blocked before the merge gate)');
  assert.equal(rec.integrateCalls, 0, 'the integrator never ran (blocked in review)');
});

test('DD3: plan-gate reject maps to the rework outcome — loops back to analyst, then approve proceeds', async () => {
  // Gate semantics are 100% in the routing data (§8): this template declares planGate outcomes
  // [approved, changes_requested] with changes_requested → analyst (a human-driven rework loop, no
  // counter). A human REJECT maps to the declared rework outcome, so the FIRST reject loops back to
  // the analyst and re-opens the plan gate; the SECOND (approve) proceeds. This proves the adapter
  // routes a gate verdict through the template (not a hardcoded cancel).
  let planSeen = 0;
  const { run, rec } = buildAdapter({
    verdicts: { codeReview: 'approved', watcherPost: 'clean' },
    gate: (topic) => {
      if (topic === 'plan') {
        planSeen++;
        return planSeen === 1 ? { decision: 'reject' } : { decision: 'approve' };
      }
      return { decision: 'approve' };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded', 'reject→rework→approve eventually completes');
  assert.equal(planSeen, 2, 'the plan gate opened twice (reject looped back to analyst, then approved)');
  assert.equal(rec.gates.filter((g) => g === 'plan').length, 2, 'analyst re-ran and re-opened the plan gate');
});

test('DD4: watcher dirty → watcherRouter default → failed terminal', async () => {
  const { run, rec } = buildAdapter({
    verdicts: { codeReview: 'approved', watcherPost: 'dirty' },
    gate: () => ({ decision: 'approve' }),
  });
  const result = await run();
  assert.equal(result.status, 'failed', 'a non-clean watcher routes to the failed terminal');
  assert.equal(rec.failed.length, 1, 'failRun called for the failed terminal');
  assert.equal(rec.completed.length, 0);
});

test('DD5: an effect that needsHuman → resultSchema/abort precedence → failed terminal (onFailure=abort)', async () => {
  const { run, rec } = buildAdapter({
    needsHumanNodes: new Set(['developer']), // developer parks → revo.ResultInvalid; node onFailure=abort
  });
  const result = await run();
  assert.equal(result.status, 'failed', 'an aborting effect failure terminates the run failed');
  assert.equal(rec.failed.length, 1);
  assert.equal(rec.completed.length, 0);
});

test('DD6: an invalid pinned template fails the run loudly (defense-in-depth validation)', async () => {
  const broken = featureDevelopment();
  // Dangle an edge: point analyst.next at a non-existent node → REF_UNRESOLVED.
  (broken.nodes['analyst'] as { next: string }).next = 'nope';
  const { run, rec } = buildAdapter({ template: broken });
  await assert.rejects(() => run(), /PINNED_TEMPLATE_INVALID/);
  assert.equal(rec.failed.length, 1, 'the top-level catch failRuns the run');
});

// ── Selection helper (templateFromExecutionPolicy) ────────────────────────────

test('SEL1: a pipeline carrying a valid template_json is detected as data-driven', () => {
  const template = featureDevelopment();
  const got = templateFromExecutionPolicy({ template_json: template });
  assert.ok(got, 'a valid embedded template is returned');
  assert.equal(got.specVersion, '1.0');
});

test('SEL2: a pipeline WITHOUT a template_json is NOT data-driven (→ hardcoded path)', () => {
  assert.equal(templateFromExecutionPolicy({ raw: ['policy text'] }), null);
  assert.equal(templateFromExecutionPolicy({}), null);
  assert.equal(templateFromExecutionPolicy(undefined), null);
});

test('SEL3: a present-but-INVALID template_json throws (fail-loud, never silent-degrade)', () => {
  const broken = featureDevelopment();
  (broken.nodes['analyst'] as { next: string }).next = 'nope';
  assert.throws(() => templateFromExecutionPolicy({ template_json: broken }), /DATA_DRIVEN_TEMPLATE_INVALID/);
  assert.throws(() => templateFromExecutionPolicy({ template_json: '{not json' }), /MALFORMED/);
  assert.throws(() => templateFromExecutionPolicy({ template_json: { foo: 1 } }), /MALFORMED/);
});

test('SEL4: a serialized (string) template_json is parsed + validated', () => {
  const template = featureDevelopment();
  const got = templateFromExecutionPolicy({ template_json: JSON.stringify(template) });
  assert.ok(got);
  assert.equal(got.pipelineId, 'feature-development');
});
