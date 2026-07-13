import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../config.js';
import type { Template } from '../pipeline-core/types.js';
import { validateTemplate } from '../pipeline-core/index.js';
import { materializeTemplate } from '../pipeline-core/materialize.js';
import {
  validateDefaultPlaybookPolicy,
  type DefaultPlaybookPolicyDiagnostic,
  type DefaultPlaybookPolicyDiagnosticCode,
} from './default-playbook-policy.js';
import { topologyProfileFromRunProfile } from './run-profiles.js';

type PipelineCatalogEntry = {
  id: string;
  execution_policy?: {
    template_json?: Template;
  };
};
type RunProfileCatalogEntry = {
  id: string;
  pipelineId: string;
  topology: unknown;
  bindings: unknown;
  status: string;
};

type MutableTemplate = Template & {
  nodes: Record<string, Record<string, unknown>>;
};

const pipelines = JSON.parse(
  readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'), 'utf8'),
) as PipelineCatalogEntry[];
const runProfiles = JSON.parse(
  readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/run-profiles.json'), 'utf8'),
) as RunProfileCatalogEntry[];

function bundledFeatureDevelopment(): Template {
  return bundledPipelineTemplate('feature-development');
}

function bundledPipelineTemplate(pipelineId: string): Template {
  const template = pipelines.find((pipeline) => pipeline.id === pipelineId)
    ?.execution_policy?.template_json;
  assert.ok(template, `${pipelineId} carries execution_policy.template_json`);
  return structuredClone(template);
}

function materializedProfile(profile: RunProfileCatalogEntry): Template {
  const base = bundledPipelineTemplate(profile.pipelineId);
  const { template, diagnostics } = materializeTemplate(
    base,
    topologyProfileFromRunProfile(profile as never),
    { allowlist: ['planReviewer', 'codeReview'] },
  );
  assert.deepEqual(diagnostics, [], `materializeTemplate emitted diagnostics for ${profile.id}: ${JSON.stringify(diagnostics)}`);
  return template;
}

function mutateTemplate(mutator: (template: MutableTemplate) => void): Template {
  const template = bundledFeatureDevelopment() as MutableTemplate;
  mutator(template);
  return template as Template;
}

function materializedConsensusProfile(): Template {
  const profile = runProfiles.find((item) => item.id === 'codex-gpt-5-6-luna-claude-opus-4-8-consensus');
  assert.ok(profile, 'codex-gpt-5-6-luna-claude-opus-4-8-consensus profile exists');
  return materializedProfile(profile);
}

function diagnosticsFor(template: Template): DefaultPlaybookPolicyDiagnostic[] {
  return validateDefaultPlaybookPolicy(template);
}

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}

function assertDiagnostic(
  template: Template,
  code: DefaultPlaybookPolicyDiagnosticCode,
): DefaultPlaybookPolicyDiagnostic {
  const diagnostics = diagnosticsFor(template);
  const diagnostic = diagnostics.find((candidate) => candidate.code === code);
  assert.ok(
    diagnostic,
    `expected ${code}; got ${diagnostics.map((candidate) => candidate.code).join(', ') || 'no diagnostics'}`,
  );
  return diagnostic;
}

function guardedBranchContaining(
  template: MutableTemplate,
  nodeId: string,
  verdict: string,
): { goto?: string; when?: unknown; default?: string } {
  const router = template.nodes[nodeId];
  const branches = router['branches'] as Array<{ goto?: string; when?: unknown; default?: string }>;
  const branch = branches.find((candidate) =>
    JSON.stringify(candidate.when).includes(`"${verdict}"`),
  );
  assert.ok(branch, `${nodeId} ${verdict} branch exists`);
  return branch;
}

function defaultBranch(template: MutableTemplate, nodeId: string): { default?: string; goto?: string; when?: unknown } {
  const router = template.nodes[nodeId];
  const branches = router['branches'] as Array<{ default?: string; goto?: string; when?: unknown }>;
  const branch = branches.find((candidate) => candidate.default !== undefined);
  assert.ok(branch, `${nodeId} default branch exists`);
  return branch;
}

test('default playbook policy: bundled feature-development passes the scoped static verifier', () => {
  assert.deepEqual(diagnosticsFor(bundledFeatureDevelopment()), []);
});

test('default playbook policy: missing produced-change handoff to integrator is diagnostic', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const integrator = template.nodes['integrator'];
      integrator['consumes'] = (integrator['consumes'] as unknown[]).filter((ref) =>
        (ref as { node?: string }).node !== 'reworkDeveloper',
      );
    }),
    'DEFAULT_POLICY_CHANGE_HANDOFF_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'integrator');
  assert.match(diagnostic.expected ?? '', /reworkDeveloper/);
});

test('default playbook policy: missing mergeReadiness freshness hop is diagnostic', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'prRouter', 'clean').goto = 'mergeGate';
    }),
    'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'prRouter');
  assert.match(diagnostic.expected ?? '', /clean -> mergeReadiness/);
});

test('default playbook policy: merge gate must surface mergeReadiness evidence', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const mergeGate = template.nodes['mergeGate'];
      mergeGate['gatedArtifact'] = { node: 'pollPr', as: 'prFeedback' };
    }),
    'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.equal(diagnostic.path, 'gatedArtifact');
});

test('default playbook policy: poll recheck routes must stay bounded by pollLoop', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'prRouter', 'recheck').when = {
        op: 'verdict.eq',
        value: 'recheck',
      };
    }),
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'prRouter');
  assert.match(diagnostic.expected ?? '', /recheck \+ pollLoop<8 -> pollPr/);
  assert.match(diagnostic.actual ?? '', /conjunctiveBound=false/);
});

test('default playbook policy: readiness routers handle terminal PR states explicitly', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'prRouter', 'merged').goto = 'confirmMerge';
      guardedBranchContaining(template, 'prRouter', 'closed').goto = 'classifyRecovery';
      guardedBranchContaining(template, 'mergeReadinessRouter', 'merged').goto = 'confirmMerge';
      guardedBranchContaining(template, 'mergeReadinessRouter', 'closed').goto = 'classifyRecovery';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING');

  for (const nodeId of ['prRouter', 'mergeReadinessRouter'] as const) {
    assert.ok(
      diagnostics.some((diagnostic) =>
        diagnostic.nodeId === nodeId &&
        /merged -> cleanupWorktree/.test(diagnostic.expected ?? ''),
      ),
      `${nodeId} must route externally merged PRs to cleanupWorktree`,
    );
    assert.ok(
      diagnostics.some((diagnostic) =>
        diagnostic.nodeId === nodeId &&
        /closed -> recoveryGate/.test(diagnostic.expected ?? ''),
      ),
      `${nodeId} must route externally closed PRs to recoveryGate`,
    );
  }
});

for (const nodeId of ['pollPr', 'mergeReadiness'] as const) {
  test(`default playbook policy: ${nodeId} must increment pollLoop`, () => {
    const diagnostic = assertDiagnostic(
      mutateTemplate((template) => {
        const node = template.nodes[nodeId];
        assert.ok(node, `${nodeId} exists`);
        delete node.incrementCounters;
      }),
      'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
    );

    assert.equal(diagnostic.nodeId, nodeId);
    assert.equal(diagnostic.path, 'incrementCounters');
    assert.match(diagnostic.expected ?? '', /pollLoop/);
  });
}

test('default playbook policy: missing review_changes route to triage is diagnostic', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeReadinessRouter', 'review_changes').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeReadinessRouter');
  assert.match(diagnostic.expected ?? '', /review_changes -> triage/);
});

test('default playbook policy: missing ci_changes routes from both PR routers are diagnostics', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'prRouter', 'ci_changes').goto = 'blockedEnd';
      guardedBranchContaining(template, 'mergeReadinessRouter', 'ci_changes').goto = 'blockedEnd';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING');

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.nodeId).sort(compareOptionalStrings),
    ['mergeReadinessRouter', 'prRouter'],
  );
  assert.ok(
    diagnostics.every((diagnostic) => /ci_changes \+ ciLoop<3 -> ciRework/.test(diagnostic.expected ?? '')),
    'diagnostics describe the bounded ciLoop route',
  );
});

test('default playbook policy: missing merge-gate reject recheck outcome is diagnostic', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      template.nodes['mergeGate']['outcomes'] = ['approved'];
    }),
    'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.equal(diagnostic.path, 'outcomes');
  assert.match(diagnostic.expected ?? '', /approved,recheck,address_review_threads,return_to_development,override_merge,cancel/);
});

test('default playbook policy: merge-gate cancel must terminate as cancelled', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeGate', 'cancel').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.match(diagnostic.expected ?? '', /cancel -> cancelledEnd/);
});

test('default playbook policy: merge-gate address_review_threads must route to triage', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeGate', 'address_review_threads').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.match(diagnostic.expected ?? '', /address_review_threads -> triage/);
});

test('default playbook policy: merge-gate return_to_development must route to triage', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeGate', 'return_to_development').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.match(diagnostic.expected ?? '', /return_to_development -> triage/);
});

test('default playbook policy: merge-gate override_merge must route to overrideMerge', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeGate', 'override_merge').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_OVERRIDE_MERGE_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.match(diagnostic.expected ?? '', /override_merge -> overrideMerge/);
});

test('default playbook policy: overrideMerge must consume mergeGate resolution and route clean to overrideConfirmMerge', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      template.nodes['overrideMerge']['scriptRef'] = 'script:pollPr';
      (template.nodes['overrideMerge']['consumes'] as unknown[]) = [];
      guardedBranchContaining(template, 'overrideMergeRouter', 'clean').goto = 'confirmMerge';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_OVERRIDE_MERGE_ROUTE_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'overrideMerge' && /script:overrideMerge/.test(diagnostic.expected ?? ''),
    ),
    'overrideMerge must use the override script',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'overrideMerge' && /mergeGate as=gateResolution/.test(diagnostic.expected ?? ''),
    ),
    'overrideMerge must consume the operator gate resolution',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'overrideMergeRouter' && /clean -> overrideConfirmMerge/.test(diagnostic.expected ?? ''),
    ),
    'overrideMerge clean route must use the override-specific confirm node',
  );
});

test('default playbook policy: overrideConfirmMerge must consume overrideMerge evidence', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const overrideConfirmMerge = template.nodes['overrideConfirmMerge'];
      overrideConfirmMerge['consumes'] = [{ node: 'mergeApproveReverify', as: 'mergeReadiness' }];
    }),
    'DEFAULT_POLICY_OVERRIDE_MERGE_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'overrideConfirmMerge');
  assert.match(diagnostic.expected ?? '', /node=overrideMerge/);
});

test('default playbook policy: merge-gate approved must route through reverify before confirmMerge', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeGate', 'approved').goto = 'confirmMerge';
    }),
    'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeGate');
  assert.match(diagnostic.expected ?? '', /approved -> mergeApproveReverify/);
});

test('default playbook policy: mergeApproveReverify must be a pollPr script node', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      template.nodes['mergeApproveReverify']['scriptRef'] = 'script:confirmMerge';
    }),
    'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeApproveReverify');
  assert.match(diagnostic.expected ?? '', /script:pollPr/);
});

test('default playbook policy: mergeApproveReverifyRouter clean must go to confirmMerge', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeApproveReverifyRouter', 'clean').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeApproveReverifyRouter');
  assert.match(diagnostic.expected ?? '', /clean -> confirmMerge/);
});

test('default playbook policy: mergeApproveReverifyRouter terminal PR states must bypass confirmMerge', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeApproveReverifyRouter', 'merged').goto = 'confirmMerge';
      guardedBranchContaining(template, 'mergeApproveReverifyRouter', 'closed').goto = 'classifyRecovery';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeApproveReverifyRouter' &&
      /merged -> cleanupWorktree/.test(diagnostic.expected ?? ''),
    ),
    'externally merged PRs must clean up without confirming merge again',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeApproveReverifyRouter' &&
      /closed -> recoveryGate/.test(diagnostic.expected ?? ''),
    ),
    'externally closed PRs must reach the human recovery gate directly',
  );
});

test('default playbook policy: mergeApproveReverifyRouter default must classify recovery', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      defaultBranch(template, 'mergeApproveReverifyRouter').default = 'recoveryGate';
    }),
    'DEFAULT_POLICY_APPROVE_REVERIFY_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeApproveReverifyRouter');
  assert.match(diagnostic.expected ?? '', /default -> classifyRecovery/);
});

test('default playbook policy: confirmMerge must consume fresh mergeApproveReverify evidence', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const confirmMerge = template.nodes['confirmMerge'];
      confirmMerge['consumes'] = [{ node: 'mergeReadiness', as: 'mergeReadiness' }];
    }),
    'DEFAULT_POLICY_MERGE_READINESS_FRESHNESS_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'confirmMerge');
  assert.match(diagnostic.expected ?? '', /node=mergeApproveReverify/);
});

test('default playbook policy: merge-gate reject must re-poll PR feedback', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      template.nodes['mergeRecheck']['scriptRef'] = 'script:confirmMerge';
    }),
    'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeRecheck');
  assert.match(diagnostic.expected ?? '', /script:pollPr/);
  assert.match(diagnostic.expected ?? '', /schema:prFeedback/);
});

test('default playbook policy: merge recheck recovery routes are diagnostic when missing', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeRecheckRouter', 'merged').goto = 'confirmMerge';
      guardedBranchContaining(template, 'mergeRecheckRouter', 'closed').goto = 'classifyRecovery';
      guardedBranchContaining(template, 'mergeRecheckRouter', 'review_changes').goto = 'blockedEnd';
      guardedBranchContaining(template, 'mergeRecheckRouter', 'ci_changes').when = {
        op: 'verdict.eq',
        value: 'ci_changes',
      };
      guardedBranchContaining(template, 'mergeRecheckRouter', 'recheck').goto = 'blockedEnd';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /review_changes -> triage/.test(diagnostic.expected ?? ''),
    ),
    'review_changes recheck route must recover through triage',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /ci_changes \+ ciLoop<3 -> ciRework/.test(diagnostic.expected ?? '') &&
      /conjunctiveBound=false/.test(diagnostic.actual ?? ''),
    ),
    'ci_changes recheck route must recover through bounded ciRework',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /recheck -> mergeReadiness/.test(diagnostic.expected ?? ''),
    ),
    'recheck verdict must continue through readiness polling',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /merged -> cleanupWorktree/.test(diagnostic.expected ?? ''),
    ),
    'merged recheck result must clean up without a merge attempt',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /closed -> recoveryGate/.test(diagnostic.expected ?? ''),
    ),
    'closed recheck result must open the recovery gate directly',
  );
});

test('default playbook policy: merge recheck clean must re-present mergeGate and default must recover', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeRecheckRouter', 'clean').goto = 'blockedEnd';
      defaultBranch(template, 'mergeRecheckRouter').default = 'blockedEnd';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /clean -> mergeGate/.test(diagnostic.expected ?? ''),
    ),
    'clean recheck result must re-present mergeGate',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /default -> recoveryGate/.test(diagnostic.expected ?? ''),
    ),
    'default recheck result must route to recoveryGate',
  );
});

test('default playbook policy: merge recheck evidence handoff is diagnostic when missing', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      for (const nodeId of ['triage', 'ciRework']) {
        const node = template.nodes[nodeId];
        node['consumes'] = (node['consumes'] as unknown[]).filter((ref) =>
          (ref as { node?: string }).node !== 'mergeRecheck',
        );
      }
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING');

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.nodeId).sort(compareOptionalStrings),
    ['ciRework', 'triage'],
  );
  assert.ok(
    diagnostics.every((diagnostic) => /node=mergeRecheck/.test(diagnostic.expected ?? '')),
    'triage and ciRework must receive mergeRecheck evidence',
  );
});

test('default playbook policy: ci_changes route must stay bounded by ciLoop', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'prRouter', 'ci_changes').when = {
        op: 'verdict.eq',
        value: 'ci_changes',
      };
    }),
    'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'prRouter');
  assert.match(diagnostic.expected ?? '', /ciLoop<3/);
  assert.match(diagnostic.actual ?? '', /conjunctiveBound=false/);
});

test('default playbook policy: ci_changes bound must be conjunctive, not any()', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeReadinessRouter', 'ci_changes').when = {
        op: 'any',
        of: [
          { op: 'verdict.eq', value: 'ci_changes' },
          { op: 'counter.lt', scope: 'ciLoop', value: 3 },
        ],
      };
    }),
    'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'mergeReadinessRouter');
  assert.match(diagnostic.expected ?? '', /ci_changes \+ ciLoop<3 -> ciRework/);
  assert.match(diagnostic.actual ?? '', /conjunctiveBound=false/);
});

test('default playbook policy: ci_changes verdict hidden in nested any() is not an exact conjunct', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'prRouter', 'ci_changes').when = {
        op: 'all',
        of: [
          {
            op: 'any',
            of: [
              { op: 'verdict.eq', value: 'ci_changes' },
              { op: 'counter.lt', scope: 'ciLoop', value: 3 },
            ],
          },
          { op: 'counter.lt', scope: 'ciLoop', value: 3 },
        ],
      };
    }),
    'DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'prRouter');
  assert.match(diagnostic.expected ?? '', /ci_changes \+ ciLoop<3 -> ciRework/);
  assert.match(diagnostic.actual ?? '', /conjunctiveBound=false/);
});

test('default playbook policy: missing developer-fix route after triage is diagnostic', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'triageRouter', 'fix').goto = 'respondThreads';
    }),
    'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'triageRouter');
  assert.match(diagnostic.expected ?? '', /fix -> reviewRework/);
});

test('default playbook policy: questionGate fix must route to question-scoped rework', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'questionGate', 'fix').goto = 'reviewRework';
    }),
    'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'questionGate');
  assert.match(diagnostic.expected ?? '', /fix -> questionReviewRework/);
});

test('default playbook policy: question-scoped rework must consume gateResolution', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const node = template.nodes['questionReviewRework'];
      node['consumes'] = [{ node: 'triage', as: 'triage' }];
    }),
    'DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'questionReviewRework');
  assert.match(diagnostic.expected ?? '', /questionGate as=gateResolution/);
});

test('default playbook policy: blocked terminal must remain first-class', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      template.nodes['blockedEnd'] = { id: 'blockedEnd', kind: 'terminal', status: 'failed' };
    }),
    'DEFAULT_POLICY_BLOCKED_TERMINAL_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'blockedEnd');
  assert.match(diagnostic.expected ?? '', /blocked/);
});

test('default playbook policy: cancelled terminal must remain first-class', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      template.nodes['cancelledEnd'] = { id: 'cancelledEnd', kind: 'terminal', status: 'blocked' };
    }),
    'DEFAULT_POLICY_CANCELLED_TERMINAL_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'cancelledEnd');
  assert.match(diagnostic.expected ?? '', /cancelled/);
});

test('default playbook policy: loop exhaustion must not dead-end directly at blockedEnd', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const router = template.nodes['codeReviewRouter'];
      const branches = router['branches'] as Array<{ default?: string; goto?: string; when?: unknown }>;
      const defaultBranch = branches.find((branch) => branch.default !== undefined);
      assert.ok(defaultBranch, 'default branch exists');
      defaultBranch.default = 'blockedEnd';
    }),
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'codeReviewRouter');
  assert.match(diagnostic.expected ?? '', /codeStuckGate/);
});

test('default playbook policy: review routers must keep pass routes and bounded rework routes', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'planReviewRouter', 'approved').goto = 'developer';
      guardedBranchContaining(template, 'planReviewRouter', 'changes_requested').when = {
        op: 'verdict.eq',
        value: 'changes_requested',
      };
      guardedBranchContaining(template, 'codeReviewRouter', 'clean').goto = 'developer';
      guardedBranchContaining(template, 'codeReviewRouter', 'blocker').when = {
        op: 'verdict.eq',
        value: 'blocker',
      };
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'planReviewRouter' &&
      /approved -> planGate/.test(diagnostic.expected ?? ''),
    ),
    'plan approved must reach planGate',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'planReviewRouter' &&
      /changes_requested \+ planReviewLoop<4 -> analyst/.test(diagnostic.expected ?? '') &&
      /conjunctiveBound=false/.test(diagnostic.actual ?? ''),
    ),
    'plan changes_requested must stay bounded by planReviewLoop',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'codeReviewRouter' &&
      /clean -> integrator/.test(diagnostic.expected ?? ''),
    ),
    'code clean must reach integrator',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'codeReviewRouter' &&
      /blocker \+ codeReviewLoop<3 -> reworkDeveloper/.test(diagnostic.expected ?? '') &&
      /conjunctiveBound=false/.test(diagnostic.actual ?? ''),
    ),
    'code blocker must stay bounded by codeReviewLoop',
  );
});

test('default playbook policy: codeStuckGate rework must route to stuckReworkDeveloper', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'codeStuckGate', 'rework').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'codeStuckGate');
  assert.match(diagnostic.expected ?? '', /rework(?: .*)? -> stuckReworkDeveloper/);
});

test('default playbook policy: codeStuckGate cancel must terminate as cancelled', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'codeStuckGate', 'cancel').goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'codeStuckGate');
  assert.match(diagnostic.expected ?? '', /cancel -> cancelledEnd/);
});

test('default playbook policy: plan gates must route rework back to analyst', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'planGate', 'rework').goto = 'developer';
    }),
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'planGate');
  assert.match(diagnostic.expected ?? '', /rework -> analyst/);
});

test('default playbook policy: planGate approval continues to development and invalid outcomes block', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'planGate', 'approved').goto = 'analyst';
      defaultBranch(template, 'planGate').default = 'cancelledEnd';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'planGate' &&
      /approved -> developer/.test(diagnostic.expected ?? ''),
    ),
    'planGate approved must continue to developer',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'planGate' &&
      /default -> blockedEnd/.test(diagnostic.expected ?? ''),
    ),
    'invalid planGate outcomes must block',
  );
});

test('default playbook policy: code review loop must be reset by stuck recovery iterations', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      assert.ok(template.scopes?.codeReviewLoop);
      template.scopes.codeReviewLoop.parent = null;
    }),
    'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING',
  );

  assert.equal(diagnostic.path, 'scopes.codeReviewLoop');
  assert.match(diagnostic.expected ?? '', /parent=codeStuckRecoveryLoop/);
});

test('default playbook policy: recoverable script catches must not route to terminal nodes', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const catches = template.nodes['pollPr']['catch'] as Array<{ onError: string; goto: string }>;
      const failed = catches.find((c) => c.onError === 'revo.ScriptFailed');
      assert.ok(failed, 'pollPr revo.ScriptFailed catch exists');
      failed.goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL',
  );

  assert.equal(diagnostic.nodeId, 'pollPr');
  assert.match(diagnostic.expected ?? '', /revo\.ScriptFailed -> non-terminal/);
  assert.match(diagnostic.actual ?? '', /revo\.ScriptFailed -> blockedEnd/);
});

test('default playbook policy: cap-router default must reach a humanGate, not a terminal', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      defaultBranch(template, 'prRouter').default = 'blockedEnd';
    }),
    'DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'prRouter');
  assert.match(diagnostic.expected ?? '', /humanGate or classifyRecovery/);
  assert.match(diagnostic.actual ?? '', /blockedEnd/);
});

test('default playbook policy: confirmMerge failure catches must not route to a terminal', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const catches = template.nodes['confirmMerge']['catch'] as Array<{ onError: string; goto: string }>;
      const failed = catches.find((c) => c.onError === 'revo.ScriptFailed');
      assert.ok(failed, 'confirmMerge revo.ScriptFailed catch exists');
      failed.goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL',
  );

  assert.equal(diagnostic.nodeId, 'confirmMerge');
  assert.match(diagnostic.expected ?? '', /revo\.ScriptFailed -> non-terminal/);
  assert.match(diagnostic.actual ?? '', /revo\.ScriptFailed -> blockedEnd/);
});

test('default playbook policy: cleanupWorktree must follow confirmMerge before mergedEnd', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      template.nodes['confirmMerge']['next'] = 'mergedEnd';
    }),
    'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'confirmMerge');
  assert.match(diagnostic.expected ?? '', /cleanupWorktree/);
});

test('default playbook policy: confirmMerge cannot bypass cleanupWorktree by removing it', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      delete template.nodes['cleanupWorktree'];
    }),
    'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'cleanupWorktree');
  assert.match(diagnostic.expected ?? '', /script:cleanupWorktree/);
});

test('default playbook policy: cleanupWorktree failure catches must still reach mergedEnd', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const catches = template.nodes['cleanupWorktree']['catch'] as Array<{ onError: string; goto: string }>;
      const failed = catches.find((c) => c.onError === 'revo.ScriptFailed');
      assert.ok(failed, 'cleanupWorktree revo.ScriptFailed catch exists');
      failed.goto = 'blockedEnd';
    }),
    'DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING',
  );

  assert.equal(diagnostic.nodeId, 'cleanupWorktree');
  assert.match(diagnostic.expected ?? '', /revo\.ScriptFailed -> mergedEnd/);
  assert.match(diagnostic.actual ?? '', /revo\.ScriptFailed -> blockedEnd/);
});

test('default playbook policy: every declared gate outcome must have an explicit guarded branch', () => {
  const diagnostic = assertDiagnostic(
    mutateTemplate((template) => {
      const gate = template.nodes['questionGate'];
      gate['outcomes'] = ['fix', 'wontfix', 'cancel'];
      gate['branches'] = [
        { when: { op: 'verdict.eq', value: 'fix' }, goto: 'questionReviewRework' },
        { when: { op: 'verdict.eq', value: 'cancel' }, goto: 'cancelledEnd' },
        { default: 'recoveryGate' },
      ];
    }),
    'DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT',
  );

  assert.equal(diagnostic.nodeId, 'questionGate');
  assert.match(diagnostic.expected ?? '', /wontfix/);
});

test('default playbook policy: recoveryGate rechecks polling, cancels as cancelled, and invalid outcomes block', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'recoveryGate', 'recheck').goto = 'mergeGate';
      guardedBranchContaining(template, 'recoveryGate', 'cancel').goto = 'blockedEnd';
      defaultBranch(template, 'recoveryGate').default = 'cancelledEnd';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'recoveryGate' &&
      /recheck -> pollPr/.test(diagnostic.expected ?? ''),
    ),
    'recovery recheck must restart PR polling',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'recoveryGate' &&
      /cancel -> cancelledEnd/.test(diagnostic.expected ?? ''),
    ),
    'recovery cancel must terminate as cancelled',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'recoveryGate' &&
      /default -> blockedEnd/.test(diagnostic.expected ?? ''),
    ),
    'invalid recovery outcomes must block',
  );
  assert.equal(
    diagnostics.filter((diagnostic) =>
      diagnostic.nodeId === 'recoveryGate' &&
      /default -> blockedEnd/.test(diagnostic.expected ?? ''),
    ).length,
    1,
    'recoveryGate default route must emit one diagnostic',
  );
});

test('default playbook policy: seeded consensus run profile has zero policy violations', () => {
  const materialized = materializedConsensusProfile();
  const diags = diagnosticsFor(materialized);
  assert.deepEqual(diags, [], `seeded consensus profile must have zero policy violations; got: ${diags.map((d) => d.code).join(', ')}`);
});

for (const profile of runProfiles.filter((item) => item.pipelineId === 'feature-development')) {
  test(`default playbook policy: seeded ${profile.id} run profile has zero policy violations`, () => {
    const materialized = materializedProfile(profile);
    const diags = diagnosticsFor(materialized);
    assert.deepEqual(diags, [], `seeded ${profile.id} profile must have zero policy violations; got: ${diags.map((d) => d.code).join(', ')}`);
  });
}

for (const profile of runProfiles.filter((item) => item.pipelineId !== 'feature-development')) {
  test(`default playbook policy: seeded ${profile.id} run profile materializes to a valid template`, () => {
    const materialized = materializedProfile(profile);
    const errors = validateTemplate(materialized).filter((diagnostic) => diagnostic.severity === 'error');
    assert.deepEqual(errors, [], `seeded ${profile.id} profile must materialize to a valid template; got: ${errors.map((d) => d.code).join(', ')}`);
  });
}
