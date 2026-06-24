import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGateSummary, GATE_ARTIFACT_MAX, GATE_PREVIEW_CHARS } from './data-driven-task.workflow.js';
import type { Decision } from '../pipeline-core/index.js';
import type { RunOutputRow } from '../run/run-outputs.js';

type AwaitGate = Extract<Decision, { type: 'awaitGate' }>;

function row(nodeId: string, payload: unknown, ordinal = 0): RunOutputRow {
  return {
    runId: 'run-1',
    nodeId,
    ordinal,
    name: `${nodeId}-out`,
    schemaRef: `schema:${nodeId}`,
    payload,
    attemptId: `${nodeId}#${ordinal}`,
  };
}
function outputs(...rows: RunOutputRow[]): Map<string, RunOutputRow[]> {
  const m = new Map<string, RunOutputRow[]>();
  for (const r of rows) m.set(r.nodeId, [...(m.get(r.nodeId) ?? []), r]);
  return m;
}
const gate = (extra: Partial<AwaitGate> = {}): AwaitGate => ({
  type: 'awaitGate',
  nodeId: 'planGate',
  reason: 'plan-review',
  outcomes: ['approved'],
  ...extra,
});

test('buildGateSummary resolves the gated artifact + verdict from outputsByNode', () => {
  const out = outputs(row('analyst', { plan: 'do X' }), row('planReviewer', { verdict: 'approved', notes: 'ok' }));
  const summary = buildGateSummary(
    gate({ gatedArtifact: { node: 'analyst', as: 'plan' }, verdictFrom: { node: 'planReviewer' } }),
    out,
    'approved',
  );

  assert.equal(summary.nodeId, 'planGate');
  assert.deepEqual(summary.gatedArtifact?.payload, { plan: 'do X' });
  assert.equal(summary.gatedArtifact?.name, 'plan'); // `as` overrides the producer's output name
  assert.equal(summary.gatedArtifact?.nodeId, 'analyst');
  assert.deepEqual((summary.reviewerVerdict as { payload: unknown }).payload, { verdict: 'approved', notes: 'ok' });
});

test('verdictFrom defaults to the routing verdict (lastVerdict) when unspecified', () => {
  const out = outputs(row('analyst', { plan: 'p' }));
  const summary = buildGateSummary(gate({ gatedArtifact: { node: 'analyst', as: 'plan' } }), out, 'changes_requested');

  assert.deepEqual(summary.reviewerVerdict, { verdict: 'changes_requested' });
});

test('a SPECIFIED but unresolved verdictFrom does NOT fall back to the routing verdict (no misattribution)', () => {
  const out = outputs(row('analyst', { plan: 'p' }));
  const summary = buildGateSummary(
    gate({ gatedArtifact: { node: 'analyst', as: 'plan' }, verdictFrom: { node: 'ghost' } }),
    out,
    'approved',
  );
  assert.equal(summary.reviewerVerdict, undefined, 'requested-but-missing verdictFrom must not show the routing verdict');
});

test('the artifact budget is measured in BYTES — a multi-byte payload under the UTF-16 limit still truncates', () => {
  // 6000 × '한' (3 bytes UTF-8 each) = ~18KB bytes but only ~6KB UTF-16 code units → a length-based
  // check would inline it; the byte-based check must truncate.
  const out = outputs(row('analyst', { s: '한'.repeat(6_000) }, 1));
  const summary = buildGateSummary(gate({ gatedArtifact: { node: 'analyst', as: 'plan' } }), out, 'approved');

  assert.equal(summary.gatedArtifact?.truncated, true, 'over the byte budget → truncated');
  assert.equal(summary.gatedArtifact?.payload, undefined);
  assert.equal(summary.gatedArtifact?.payloadRef, 'attempt:analyst#1');
});

test('a missing producer omits the artifact (best-effort) and never throws', () => {
  const summary = buildGateSummary(gate({ gatedArtifact: { node: 'analyst', as: 'plan' } }), new Map(), 'approved');
  assert.equal(summary.gatedArtifact, undefined);
  assert.deepEqual(summary.reviewerVerdict, { verdict: 'approved' });
});

test('an over-budget artifact becomes a head preview + an attempt locator (no full payload)', () => {
  const big = 'x'.repeat(GATE_ARTIFACT_MAX + 5_000);
  const out = outputs(row('analyst', { plan: big }, 2));
  const summary = buildGateSummary(gate({ gatedArtifact: { node: 'analyst', as: 'plan' } }), out, 'approved');

  const art = summary.gatedArtifact;
  assert.ok(art);
  assert.equal(art.truncated, true);
  assert.equal(art.payload, undefined, 'the full payload is NOT inlined when over budget');
  assert.equal(art.preview?.length, GATE_PREVIEW_CHARS);
  assert.equal(art.payloadRef, 'attempt:analyst#2', 'locator points at the producing attempt (full artifact via its agent log)');
});

test('secrets + token shapes are scrubbed from the inlined payload AND the over-budget preview', () => {
  const token = `ghp_${'A'.repeat(36)}`;
  // Within budget → inlined payload is redacted.
  const small = buildGateSummary(
    gate({ gatedArtifact: { node: 'analyst', as: 'plan' } }),
    outputs(row('analyst', { note: `deploy with ${token}`, password: 'hunter2' })),
    'approved',
  );
  const payload = small.gatedArtifact?.payload as { note: string; password: string };
  assert.ok(!JSON.stringify(payload).includes(token), 'token shape scrubbed from the inlined payload');
  assert.ok(!JSON.stringify(payload).includes('hunter2'), 'secret-named key value scrubbed from the inlined payload');

  // Over budget → the preview is derived from the redacted serialization, so the token never leaks.
  // (filler uses spaces so it stays large after redaction — a contiguous alphanumeric run would be
  // absorbed into the token-shape match.)
  const big = buildGateSummary(
    gate({ gatedArtifact: { node: 'analyst', as: 'plan' } }),
    outputs(row('analyst', { token, filler: 'lorem ipsum dolor '.repeat(1_200) })),
    'approved',
  );
  assert.equal(big.gatedArtifact?.truncated, true);
  assert.ok(!big.gatedArtifact?.preview?.includes(token), 'token shape scrubbed from the over-budget preview');
  assert.ok((big.gatedArtifact?.preview?.length ?? 0) > 0, 'preview present');
});

test('iteration:latest picks the most recent ordinal; a pinned number selects that ordinal', () => {
  const out = outputs(row('analyst', { plan: 'v1' }, 0), row('analyst', { plan: 'v2' }, 1));
  const latest = buildGateSummary(gate({ gatedArtifact: { node: 'analyst' } }), out, 'approved');
  assert.deepEqual(latest.gatedArtifact?.payload, { plan: 'v2' });

  const pinned = buildGateSummary(gate({ gatedArtifact: { node: 'analyst', iteration: 0 } }), out, 'approved');
  assert.deepEqual(pinned.gatedArtifact?.payload, { plan: 'v1' });
});

test('replay determinism: the enriched summary does not depend on call order — pure over outputsByNode', () => {
  const out = outputs(row('analyst', { plan: 'p' }), row('planReviewer', { verdict: 'approved' }));
  const d = gate({ gatedArtifact: { node: 'analyst', as: 'plan' }, verdictFrom: { node: 'planReviewer' } });
  assert.deepEqual(buildGateSummary(d, out, 'approved'), buildGateSummary(d, out, 'approved'));
});
