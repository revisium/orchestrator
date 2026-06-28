import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../config.js';
import type { Template } from '../pipeline-core/types.js';
import {
  validateDefaultFeatureDevelopmentPolicy,
  type DefaultPlaybookPolicyDiagnostic,
  type DefaultPlaybookPolicyDiagnosticCode,
} from './default-playbook-policy.js';

type PipelineCatalogEntry = {
  id: string;
  execution_policy?: {
    template_json?: Template;
  };
};

type MutableTemplate = Template & {
  nodes: Record<string, Record<string, unknown>>;
};

const pipelines = JSON.parse(
  readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'), 'utf8'),
) as PipelineCatalogEntry[];

function bundledFeatureDevelopment(): Template {
  const template = pipelines.find((pipeline) => pipeline.id === 'feature-development')
    ?.execution_policy?.template_json;
  assert.ok(template, 'feature-development carries execution_policy.template_json');
  return structuredClone(template);
}

function mutateTemplate(mutator: (template: MutableTemplate) => void): Template {
  const template = bundledFeatureDevelopment() as MutableTemplate;
  mutator(template);
  return template as Template;
}

function diagnosticsFor(template: Template): DefaultPlaybookPolicyDiagnostic[] {
  return validateDefaultFeatureDevelopmentPolicy(template);
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
    diagnostics.map((diagnostic) => diagnostic.nodeId).sort(),
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
  assert.match(diagnostic.expected ?? '', /approved,recheck/);
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
      guardedBranchContaining(template, 'mergeRecheckRouter', 'review_changes').goto = 'blockedEnd';
      guardedBranchContaining(template, 'mergeRecheckRouter', 'ci_changes').when = {
        op: 'verdict.eq',
        value: 'ci_changes',
      };
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
});

test('default playbook policy: merge recheck clean/default abort path is diagnostic when missing', () => {
  const diagnostics = diagnosticsFor(
    mutateTemplate((template) => {
      guardedBranchContaining(template, 'mergeRecheckRouter', 'clean').goto = 'mergeGate';
      defaultBranch(template, 'mergeRecheckRouter').default = 'mergeGate';
    }),
  ).filter((diagnostic) => diagnostic.code === 'DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING');

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /clean -> blockedEnd/.test(diagnostic.expected ?? ''),
    ),
    'clean recheck result must remain an explicit abort',
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.nodeId === 'mergeRecheckRouter' &&
      /default -> blockedEnd/.test(diagnostic.expected ?? ''),
    ),
    'default recheck result must remain an explicit abort',
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
    diagnostics.map((diagnostic) => diagnostic.nodeId).sort(),
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
