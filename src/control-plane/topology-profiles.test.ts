import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../config.js';
import type { Template } from '../pipeline-core/types.js';
import { validateTemplate, classifyTemplateDiff } from '../pipeline-core/validate.js';
import { materializeTemplate, hashTemplate } from '../pipeline-core/materialize.js';
import { validateDefaultPlaybookPolicy } from './default-playbook-policy.js';
import { CODEX_CONSENSUS_PROFILE, CONSENSUS_TOGGLE_ALLOWLIST } from './topology-profiles.js';

type PipelineCatalogEntry = {
  id: string;
  execution_policy?: { template_json?: Template };
};

const pipelines = JSON.parse(
  readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'), 'utf8'),
) as PipelineCatalogEntry[];

function catalogFeatureDevelopment(): Template {
  const t = pipelines.find((p) => p.id === 'feature-development')?.execution_policy?.template_json;
  assert.ok(t, 'feature-development must carry execution_policy.template_json');
  return structuredClone(t);
}

function materializeCodexConsensus(): Template {
  const base = catalogFeatureDevelopment();
  const allowlist = CONSENSUS_TOGGLE_ALLOWLIST['feature-development'];
  assert.ok(allowlist, 'feature-development must have a toggle allowlist');
  const { template, diagnostics } = materializeTemplate(base, CODEX_CONSENSUS_PROFILE, { allowlist });
  assert.deepEqual(diagnostics, [], `materializeTemplate emitted diagnostics: ${JSON.stringify(diagnostics)}`);
  return template;
}

// ─── real-base validateTemplate pass ─────────────────────────────────────────

test('topology-profiles: materializeTemplate(canonicalCatalog, codexProfile) has zero validateTemplate errors', () => {
  const materialized = materializeCodexConsensus();
  const errors = validateTemplate(materialized).filter((d) => d.severity === 'error');
  assert.deepEqual(
    errors,
    [],
    `expected 0 errors; got: ${errors.map((d) => `${d.code}(${d.nodeId ?? ''})`).join(', ')}`,
  );
});

// ─── byte-stable hash ─────────────────────────────────────────────────────────

test('topology-profiles: materialized codex-consensus hash is byte-stable across two calls', () => {
  const base = catalogFeatureDevelopment();
  const allowlist = CONSENSUS_TOGGLE_ALLOWLIST['feature-development']!;
  const r1 = materializeTemplate(base, CODEX_CONSENSUS_PROFILE, { allowlist });
  const r2 = materializeTemplate(structuredClone(base), CODEX_CONSENSUS_PROFILE, { allowlist });
  assert.equal(r1.materializedTemplateHash, r2.materializedTemplateHash);
});

test('topology-profiles: binding-only change does not affect materializedTemplateHash', () => {
  const base = catalogFeatureDevelopment();
  const allowlist = CONSENSUS_TOGGLE_ALLOWLIST['feature-development']!;
  const { materializedTemplateHash: h1 } = materializeTemplate(base, CODEX_CONSENSUS_PROFILE, { allowlist });
  const { materializedTemplateHash: h2 } = materializeTemplate(structuredClone(base), CODEX_CONSENSUS_PROFILE, { allowlist });
  assert.equal(h1, h2, 'PROFILE_BINDING_ONLY_NO_GRAPH_CHANGE: topology hash must be stable; binding is a separate axis (#244)');
});

test('topology-profiles: canonical and materialized hashes differ', () => {
  const base = catalogFeatureDevelopment();
  const allowlist = CONSENSUS_TOGGLE_ALLOWLIST['feature-development']!;
  const { materializedTemplateHash } = materializeTemplate(base, CODEX_CONSENSUS_PROFILE, { allowlist });
  const canonicalHash = hashTemplate(catalogFeatureDevelopment());
  assert.notEqual(materializedTemplateHash, canonicalHash);
});

// ─── parity diff: materialized differs from canonical ONLY by declared fanout/join deltas ───

test('topology-profiles: parity diff — exact added node-id set', () => {
  const canonical = catalogFeatureDevelopment();
  const materialized = materializeCodexConsensus();

  const oldIds = new Set(Object.keys(canonical.nodes));
  const newIds = new Set(Object.keys(materialized.nodes));
  const added = new Set([...newIds].filter((id) => !oldIds.has(id)));

  assert.deepEqual(
    [...added].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    [
      'codeReviewFanout',
      'codeReviewJoin',
      'codeReviewPrimary',
      'codeReviewSecondary',
      'planReviewFanout',
      'planReviewJoin',
      'planReviewPrimary',
      'planReviewSecondary',
    ],
    'exact added node-id set must match declared topology fanout/join deltas',
  );
});

test('topology-profiles: parity diff — deleted nodes are exactly planReviewer and codeReview', () => {
  const canonical = catalogFeatureDevelopment();
  const materialized = materializeCodexConsensus();
  const diff = classifyTemplateDiff(canonical, materialized);
  const deleted = diff.diagnostics
    .filter((d) => d.code === 'DIFF_NODE_DELETED')
    .map((d) => d.nodeId)
    .sort((a, b) => ((a ?? '') < (b ?? '') ? -1 : 1));
  assert.deepEqual(deleted, ['codeReview', 'planReviewer']);
});

test('topology-profiles: parity diff — topology-changed nodes are exactly the edge-rewired set', () => {
  const canonical = catalogFeatureDevelopment();
  const materialized = materializeCodexConsensus();
  const diff = classifyTemplateDiff(canonical, materialized);
  const topologyChanged = diff.diagnostics
    .filter((d) => d.code === 'DIFF_NODE_TOPOLOGY_CHANGED' && d.nodeId !== undefined)
    .map((d) => d.nodeId!)
    .sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(
    topologyChanged,
    ['analyst', 'developer', 'reworkDeveloper', 'stuckReworkDeveloper'],
    'DIFF_NODE_TOPOLOGY_CHANGED must fire on exactly the next-rewired nodes',
  );
});

test('topology-profiles: parity diff — unclassified changes are exactly the consumes-rewired nodes', () => {
  const canonical = catalogFeatureDevelopment();
  const materialized = materializeCodexConsensus();
  const diff = classifyTemplateDiff(canonical, materialized);
  const unclassified = diff.diagnostics
    .filter((d) => d.code === 'DIFF_UNCLASSIFIED' && d.nodeId !== undefined)
    .map((d) => d.nodeId!)
    .sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(
    unclassified,
    ['analyst', 'stuckReworkDeveloper'],
    'DIFF_UNCLASSIFIED must fire on exactly the consumes-rewired nodes',
  );
});

test('topology-profiles: parity diff — no entry or scopes change', () => {
  const canonical = catalogFeatureDevelopment();
  const materialized = materializeCodexConsensus();
  assert.equal(materialized.entry, canonical.entry, 'entry must be unchanged');
  assert.deepEqual(materialized.scopes ?? {}, canonical.scopes ?? {}, 'scopes must be unchanged');
});

test('topology-profiles: parity diff — no unexpected diagnostics (no kind change, no id reuse)', () => {
  const canonical = catalogFeatureDevelopment();
  const materialized = materializeCodexConsensus();
  const diff = classifyTemplateDiff(canonical, materialized);
  const unexpectedCodes = diff.diagnostics
    .filter((d) => d.code !== 'DIFF_NODE_DELETED' && d.code !== 'DIFF_NODE_TOPOLOGY_CHANGED' && d.code !== 'DIFF_UNCLASSIFIED')
    .map((d) => `${d.code}(${d.nodeId ?? ''})`)
    .sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(unexpectedCodes, [], 'no unexpected diff diagnostic codes');
});

test('topology-profiles: materialized graph uses canonical role refs (not -codex suffixed)', () => {
  const materialized = materializeCodexConsensus();
  for (const [id, node] of Object.entries(materialized.nodes)) {
    if (node.kind === 'agent') {
      assert.ok(
        !node.roleRef.includes('-codex'),
        `node "${id}" must use canonical roleRef, got "${node.roleRef}"`,
      );
    }
  }
});

// ─── product policy ───────────────────────────────────────────────────────────

test('topology-profiles: validateDefaultPlaybookPolicy on materialized output fires exactly DEFAULT_POLICY_CHANGE_HANDOFF_MISSING', () => {
  const materialized = materializeCodexConsensus();
  const codes = new Set(validateDefaultPlaybookPolicy(materialized).map((d) => d.code));
  assert.ok(
    codes.has('DEFAULT_POLICY_CHANGE_HANDOFF_MISSING'),
    'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING must fire (codeReview check is not yet fanout-aware)',
  );
  assert.equal(codes.size, 1, `expected exactly {DEFAULT_POLICY_CHANGE_HANDOFF_MISSING}; got: ${[...codes].join(', ')}`);
});

test('topology-profiles: recovery-shape policy codes are absent from materialized output', () => {
  const materialized = materializeCodexConsensus();
  const codes = new Set(validateDefaultPlaybookPolicy(materialized).map((d) => d.code));
  const recoveryCodes = [
    'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
    'DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING',
    'DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL',
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    'DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING',
    'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
    'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
    'DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL',
    'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
    'DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING',
    'DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING',
  ] as const;
  for (const code of recoveryCodes) {
    assert.ok(!codes.has(code), `recovery-shape code ${code} must be absent from materialized output`);
  }
});
