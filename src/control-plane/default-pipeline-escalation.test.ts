/**
 * default-pipeline-escalation.test.ts — guards the slice-142/B escalation gates in the built-in
 * `feature-development` pipeline: when an agent-convergence loop EXHAUSTS its cap, the run must route
 * to a HUMAN gate (approve-as-is / abort), NOT silently dead-end at `blockedEnd`. A live dogfood run
 * blocked exactly this way, throwing away the reviewer's (valuable) last verdict.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../config.js';

type Node = { id: string; kind: string; branches?: Array<{ default?: string; goto?: string; when?: unknown }> };

function featureDevNodes(): Record<string, Node> {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'), 'utf8'),
  ) as Array<{ id: string; execution_policy?: { template_json?: { nodes: Record<string, Node> } } }>;
  const fd = raw.find((p) => p.id === 'feature-development');
  assert.ok(fd?.execution_policy?.template_json?.nodes, 'feature-development template_json.nodes present');
  return fd.execution_policy.template_json.nodes;
}

/** The choice router's catch-all (`default`) branch target. */
const routerDefault = (n: Node): string | undefined => n.branches?.find((b) => b.default !== undefined)?.default;
/** The humanGate's approve→ target. */
const approveGoto = (n: Node): string | undefined =>
  n.branches?.find((b) => b.goto !== undefined && b.when !== undefined)?.goto;

test('plan-review loop exhaustion escalates to a human gate, not blockedEnd', () => {
  const nodes = featureDevNodes();
  assert.equal(routerDefault(nodes['planReviewRouter']), 'planStuckGate', 'planReviewRouter default → planStuckGate');
  const gate = nodes['planStuckGate'];
  assert.equal(gate?.kind, 'humanGate');
  assert.equal(approveGoto(gate), 'developer', 'approve → proceed with the current plan');
  assert.equal(routerDefault(gate), 'blockedEnd', 'reject → abort');
});

test('code-review loop exhaustion escalates to a human gate, not blockedEnd', () => {
  const nodes = featureDevNodes();
  assert.equal(routerDefault(nodes['codeReviewRouter']), 'codeStuckGate', 'codeReviewRouter default → codeStuckGate');
  const gate = nodes['codeStuckGate'];
  assert.equal(gate?.kind, 'humanGate');
  assert.equal(approveGoto(gate), 'integrator', 'approve → accept the code as-is');
  assert.equal(routerDefault(gate), 'blockedEnd', 'reject → abort');
});

test('the two agent-convergence routers no longer dead-end straight to blockedEnd', () => {
  const nodes = featureDevNodes();
  assert.notEqual(routerDefault(nodes['planReviewRouter']), 'blockedEnd');
  assert.notEqual(routerDefault(nodes['codeReviewRouter']), 'blockedEnd');
});
