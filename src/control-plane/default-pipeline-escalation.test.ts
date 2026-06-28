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

/** A guard branch's goto, found by its `verdict.eq` value (for routers keyed on a domain verdict). */
const gotoForVerdict = (n: Node, value: string): string | undefined =>
  n.branches?.find((b) => {
    const when = b.when as { op?: string; value?: string; of?: Array<{ op?: string; value?: string }> } | undefined;
    if (when?.op === 'verdict.eq' && when.value === value) return true;
    // ci_changes is guarded by an `all` of (verdict.eq ci_changes, counter.lt ciLoop) — match the nested eq.
    return when?.op === 'all' && (when.of ?? []).some((c) => c.op === 'verdict.eq' && c.value === value);
  })?.goto;

test('#141: a merge-gate reject is evidence-driven — re-polls fresh readiness and routes on the fresh verdict', () => {
  // The merge gate must NOT always terminal-block on reject. Reject maps (gateVerdict) to the LAST declared
  // outcome, so a 2nd outcome on the gate routes the reject to a dedicated re-poll; the re-poll's router then
  // routes on the FRESH verdict: clean→blockedEnd (explicit abort), review_changes→triage / ci_changes→ciRework
  // (recoverable). Approve still proceeds to confirmMerge. Pure routing-data change (no gateVerdict/Decision/MCP).
  const nodes = featureDevNodes();
  const mergeGate = nodes['mergeGate'];
  assert.equal(mergeGate?.kind, 'humanGate', 'mergeGate is a humanGate');
  assert.equal(approveGoto(mergeGate), 'confirmMerge', 'approve → confirmMerge (unchanged)');

  // The reject branch is the non-approve, non-default goto (gateVerdict maps reject → the last outcome).
  const rejectGoto = mergeGate.branches?.find(
    (b) => b.goto !== undefined && b.when !== undefined && b.goto !== approveGoto(mergeGate),
  )?.goto;
  assert.ok(rejectGoto, 'mergeGate has a reject (non-approve) branch that re-checks readiness');

  const recheck = nodes[rejectGoto] as Node & { scriptRef?: string; next?: string };
  assert.equal(recheck?.kind, 'script', 'the reject routes to a script node');
  assert.equal(recheck.scriptRef, 'script:pollPr', 'the reject re-polls fresh PR readiness (pollPr)');

  const router = nodes[recheck.next as string];
  assert.equal(router?.kind, 'choice', 'the re-poll feeds a choice router that routes on the fresh verdict');
  // Explicit abort is statically reachable: a clean re-poll AND the catch-all default both terminate at blockedEnd.
  assert.equal(gotoForVerdict(router, 'clean'), 'blockedEnd', 'clean re-poll → blockedEnd (explicit abort)');
  assert.equal(routerDefault(router), 'blockedEnd', 'default → blockedEnd (abort reachable)');
  // Recoverable verdicts rejoin the existing bounded loops instead of dead-ending.
  assert.equal(gotoForVerdict(router, 'review_changes'), 'triage', 'review_changes re-poll → triage (recoverable)');
  assert.equal(gotoForVerdict(router, 'ci_changes'), 'ciRework', 'ci_changes re-poll → ciRework (recoverable)');
});
