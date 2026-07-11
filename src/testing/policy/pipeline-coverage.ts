import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../config.js';
import type { DefaultPlaybookPolicyDiagnosticCode } from '../../control-plane/default-playbook-policy.js';
import { PR_LIFECYCLE_NODES, topologyProfileFromRunProfile } from '../../control-plane/run-profiles.js';
import { hashTemplate, materializeTemplate } from '../../pipeline-core/materialize.js';
import type { Branch, Condition, RevoErrorCode, Template } from '../../pipeline-core/types.js';
import { isDefaultBranch, isGuardedBranch } from '../../pipeline-core/types.js';
import {
  validateNonDslPipelineCaseAttachment,
  type PipelineNonDslCaseAttachment,
} from './non-dsl-ownership.js';

export type PipelineCoverageTag =
  | `node:${string}:outcome:${string}`
  | `node:${string}:catch:${RevoErrorCode}`
  | `node:${string}:default`
  | `profile:${string}:signature:${string}`;

export type PipelineCoverageCellId = string & { readonly __pipelineCoverageCellId: unique symbol };

export type PipelineScenarioCoverage = Readonly<{
  kind: 'registered-dsl';
  scenarioId: PipelineCoverageScenarioId;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  catalogIdentity: string;
  materialized: MaterializedCoverageIdentity;
  cellIds: readonly PipelineCoverageCellId[];
  primaryCellIds: readonly PipelineCoverageCellId[];
}>;

export type PipelineCaseAttachment = PipelineScenarioCoverage | PipelineNonDslCaseAttachment;

export type PipelineCoverageOwner = 'dsl' | 'static-policy' | 'unit' | 'waiver';
type PipelineCoverageStage = 'stage-2' | 'stage-3' | 'later';

export type PipelineCoverageOwnership = Readonly<{
  owner: Exclude<PipelineCoverageOwner, 'dsl' | 'waiver'>;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  materialized: readonly MaterializedCoverageIdentity[];
  cellIds: readonly PipelineCoverageCellId[];
  primaryCellIds: readonly PipelineCoverageCellId[];
  diagnosticCode?: DefaultPlaybookPolicyDiagnosticCode;
}>;

export type PipelineCoverageWaiver = Readonly<{
  id: string;
  reason: string;
  ownerSurface: string;
  tags?: readonly PipelineCoverageTag[];
  materialized: readonly MaterializedCoverageIdentity[];
  cellIds: readonly PipelineCoverageCellId[];
  expiry?: Readonly<{
    stage?: PipelineCoverageStage;
    condition?: string;
  }>;
}>;

export type PipelineCoverageDiagnosticCode =
  | 'PIPELINE_COVERAGE_UNDEFINED_CELL'
  | 'PIPELINE_COVERAGE_INCONSISTENT_PRIMARY_CLAIM'
  | 'PIPELINE_COVERAGE_UNOWNED_CELL'
  | 'PIPELINE_COVERAGE_DUPLICATE_OWNER'
  | 'PIPELINE_COVERAGE_OWNED_AND_WAIVED'
  | 'PIPELINE_COVERAGE_INCOMPLETE_WAIVER'
  | 'PIPELINE_COVERAGE_EXPIRED_WAIVER'
  | 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL';

export type PipelineCoverageDiagnostic = {
  code: PipelineCoverageDiagnosticCode;
  message: string;
  cellId?: PipelineCoverageCellId;
  tag?: PipelineCoverageTag;
  scenarioId?: string;
  ownerSurface?: string;
  waiverId?: string;
};

export type PipelineCatalogCoverageInput = {
  id: string;
  execution_policy?: {
    template_json?: Template;
  };
};

export type RunProfileCoverageInput = {
  id: string;
  pipelineId: string;
  topology: unknown;
  status?: string;
};

export type MaterializedCoverageIdentity = Readonly<{
  pipelineId: string;
  profileId: string;
  materializedTemplateHash: string;
  routingSignature: string;
}>;

export type DerivedPipelineCoverageCatalog = Readonly<{
  catalogIdentity: string;
  tags: readonly PipelineCoverageTag[];
  materialized: readonly MaterializedCoverageIdentity[];
  cells: readonly PipelineCoverageCell[];
}>;

export type PipelineCoverageCell = Readonly<{
  id: PipelineCoverageCellId;
  tag: PipelineCoverageTag;
  materialized: MaterializedCoverageIdentity;
}>;

export type PipelineCoverageManifest = Readonly<{
  registry: PipelineCoverageRegistry;
  catalog: DerivedPipelineCoverageCatalog;
  attachments: readonly PipelineScenarioCoverage[];
}>;

type DefinedPipelineCoverageManifest = Readonly<{
  publicManifest: PipelineCoverageManifest;
  attachmentLookup: ReadonlyMap<PipelineCoverageScenarioId, PipelineScenarioCoverage>;
}>;

export type PipelineCoverageRegistry = Readonly<{
  scenarios: readonly PipelineDslCoverageScenario[];
  ownership: readonly PipelineCoverageOwnership[];
  waivers: readonly PipelineCoverageWaiver[];
}>;

export type PipelineDslCoverageScenario = Readonly<{
  id: string;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  materialized: MaterializedCoverageIdentity;
  cellIds: readonly PipelineCoverageCellId[];
  primaryCellIds: readonly PipelineCoverageCellId[];
}>;

type MaterializedCoverageSelector = Readonly<{ pipelineId: string; profileId: string }>;

type PipelineDslCoverageScenarioDeclaration = Readonly<{
  id: string;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  materialized: MaterializedCoverageSelector;
}>;

type PipelineCoverageOwnershipDeclaration = Readonly<{
  owner: Exclude<PipelineCoverageOwner, 'dsl' | 'waiver'>;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  materialized: readonly MaterializedCoverageSelector[];
  diagnosticCode?: DefaultPlaybookPolicyDiagnosticCode;
}>;

type PipelineCoverageWaiverDeclaration = Readonly<{
  id: string;
  reason: string;
  ownerSurface: string;
  tags?: readonly PipelineCoverageTag[];
  materialized?: readonly MaterializedCoverageSelector[];
  expiry?: Readonly<{
    stage?: PipelineCoverageStage;
    condition?: string;
  }>;
}>;

type PipelineCoverageRegistryInput = Readonly<{
  scenarios: readonly PipelineDslCoverageScenarioDeclaration[];
  ownership: readonly PipelineCoverageOwnershipDeclaration[];
  waivers: readonly PipelineCoverageWaiverDeclaration[];
}>;

type PipelineDslCoverageScenarioWithId<Id extends string> = PipelineDslCoverageScenarioDeclaration & {
  readonly id: Id;
};

const DEFAULT_PLAYBOOK_POLICY_TEST = 'src/control-plane/default-playbook-policy.test.ts';
const RECOVERY_GRAPH_E2E_TEST = 'src/e2e/pipeline/recovery-graph.e2e.test.ts';
const RUNNER_RETRY_GATE_E2E_TEST = 'src/e2e/pipeline/runner-retry-gate.e2e.test.ts';
const SEED_DEFAULT_PLAYBOOK_E2E_TEST = 'src/e2e/pipeline/seeded-profiles.e2e.test.ts';
const TARGET_CONTRACT_E2E_TEST = 'src/e2e/pipeline/target-contract-red-suite.e2e.test.ts';
const FEATURE_BASE_MATERIALIZED = { pipelineId: 'feature-development', profileId: 'base' } as const;

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function dslScenario<const Id extends string>(
  id: Id,
  ownerSurface: string,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[] = tags,
  materialized: Readonly<{ pipelineId: string; profileId: string }> = FEATURE_BASE_MATERIALIZED,
): PipelineDslCoverageScenarioWithId<Id> {
  return { id, ownerSurface, tags, primaryTags, materialized };
}

function recoveryGraphScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[] = tags,
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, RECOVERY_GRAPH_E2E_TEST, tags, primaryTags);
}

function runnerRetryGateScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[] = tags,
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, RUNNER_RETRY_GATE_E2E_TEST, tags, primaryTags);
}

function targetContractScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[] = tags,
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, TARGET_CONTRACT_E2E_TEST, tags, primaryTags);
}

function seedDefaultPlaybookScenario<const Id extends string>(
  id: Id,
  materialized: Readonly<{ pipelineId: string; profileId: string }>,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[] = tags,
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, SEED_DEFAULT_PLAYBOOK_E2E_TEST, tags, primaryTags, materialized);
}

function nodeOutcome(nodeId: string, outcome: string): PipelineCoverageTag {
  return `node:${nodeId}:outcome:${outcome}`;
}

function nodeOutcomes(nodeId: string, outcomes: readonly string[]): PipelineCoverageTag[] {
  return outcomes.map((outcome) => nodeOutcome(nodeId, outcome));
}

function nodeCatch(nodeId: string, errorCode: RevoErrorCode): PipelineCoverageTag {
  return `node:${nodeId}:catch:${errorCode}`;
}

function nodeCatches(nodeIds: readonly string[]): PipelineCoverageTag[] {
  const tags: PipelineCoverageTag[] = [];
  for (const nodeId of nodeIds) {
    tags.push(nodeCatch(nodeId, 'revo.ScriptBlocked'), nodeCatch(nodeId, 'revo.ScriptFailed'));
  }
  return tags;
}

function nodeDefault(nodeId: string): PipelineCoverageTag {
  return `node:${nodeId}:default`;
}

function profileSignature(profileId: string, signature: string): PipelineCoverageTag {
  return `profile:${profileId}:signature:${signature}`;
}

function staticPolicy(
  diagnosticCode: DefaultPlaybookPolicyDiagnosticCode,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[],
  materialized: readonly MaterializedCoverageSelector[] = FEATURE_MATERIALIZED,
): PipelineCoverageOwnershipDeclaration {
  return {
    owner: 'static-policy',
    ownerSurface: DEFAULT_PLAYBOOK_POLICY_TEST,
    diagnosticCode,
    tags,
    primaryTags,
    materialized,
  };
}

function staticPolicyPrimaryOwnership(
  diagnosticCode: DefaultPlaybookPolicyDiagnosticCode,
  tags: readonly PipelineCoverageTag[],
  materialized: readonly MaterializedCoverageSelector[],
): PipelineCoverageOwnershipDeclaration {
  return staticPolicy(diagnosticCode, tags, tags, materialized);
}

function unit(
  ownerSurface: string,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[],
  materialized: readonly MaterializedCoverageSelector[],
): PipelineCoverageOwnershipDeclaration {
  return { owner: 'unit', ownerSurface, tags, primaryTags, materialized };
}

const SINGLE_REVIEW_PROFILE_TAGS = [
  profileSignature('claude-standard', 'single-review'),
  profileSignature('codex-standard', 'single-review'),
] as const;

const CONSENSUS_PROFILE_TAGS = [
  profileSignature('codex-primary-claude-review-consensus', 'dual-consensus-review'),
  profileSignature('claude-primary-codex-review-consensus', 'dual-consensus-review'),
] as const;

const LOCAL_CHANGE_PROFILE_TAGS = [
  profileSignature('local-change-claude-standard', 'developer-single'),
  profileSignature('local-change-codex-standard', 'developer-single'),
] as const;

const ANALYSIS_ONLY_PROFILE_TAGS = [
  profileSignature('analysis-only-claude-standard', 'analyst-single'),
  profileSignature('analysis-only-codex-standard', 'analyst-single'),
] as const;

const FEATURE_CLAUDE_STANDARD_MATERIALIZED = {
  pipelineId: 'feature-development',
  profileId: 'claude-standard',
} as const;
const FEATURE_CODEX_STANDARD_MATERIALIZED = {
  pipelineId: 'feature-development',
  profileId: 'codex-standard',
} as const;
const FEATURE_CODEX_CONSENSUS_MATERIALIZED = {
  pipelineId: 'feature-development',
  profileId: 'codex-primary-claude-review-consensus',
} as const;
const FEATURE_CLAUDE_CONSENSUS_MATERIALIZED = {
  pipelineId: 'feature-development',
  profileId: 'claude-primary-codex-review-consensus',
} as const;

const FEATURE_SIBLING_MATERIALIZED = [
  FEATURE_CLAUDE_STANDARD_MATERIALIZED,
  FEATURE_CODEX_STANDARD_MATERIALIZED,
  FEATURE_CODEX_CONSENSUS_MATERIALIZED,
  FEATURE_CLAUDE_CONSENSUS_MATERIALIZED,
] as const satisfies readonly MaterializedCoverageSelector[];

const FEATURE_MATERIALIZED = [
  FEATURE_BASE_MATERIALIZED,
  ...FEATURE_SIBLING_MATERIALIZED,
] as const satisfies readonly MaterializedCoverageSelector[];

const FEATURE_STATIC_APPROVAL_MATERIALIZED = [
  FEATURE_BASE_MATERIALIZED,
  FEATURE_CLAUDE_STANDARD_MATERIALIZED,
  FEATURE_CODEX_CONSENSUS_MATERIALIZED,
  FEATURE_CLAUDE_CONSENSUS_MATERIALIZED,
] as const satisfies readonly MaterializedCoverageSelector[];

const FEATURE_STATIC_REWORK_MATERIALIZED = [
  FEATURE_BASE_MATERIALIZED,
  FEATURE_CLAUDE_STANDARD_MATERIALIZED,
  FEATURE_CODEX_STANDARD_MATERIALIZED,
  FEATURE_CLAUDE_CONSENSUS_MATERIALIZED,
] as const satisfies readonly MaterializedCoverageSelector[];

const PIPELINE_DSL_COVERAGE_SCENARIOS = [
  recoveryGraphScenario(
    'RG-A-merge-approved',
    [
      nodeOutcome('mergeGate', 'approved'),
      nodeOutcome('mergeApproveReverifyRouter', 'clean'),
    ],
  ),
  recoveryGraphScenario(
    'RG-B-merge-cancel',
    [
      nodeOutcome('mergeGate', 'cancel'),
    ],
  ),
  recoveryGraphScenario(
    'RG-C-merge-override',
    [
      nodeOutcome('mergeGate', 'override_merge'),
      nodeOutcome('overrideMergeRouter', 'clean'),
    ],
  ),
  recoveryGraphScenario(
    'RG-D-merge-recheck-clean',
    [
      nodeOutcome('mergeGate', 'recheck'),
      nodeOutcome('mergeRecheckRouter', 'clean'),
      nodeOutcome('mergeGate', 'cancel'),
    ],
    [
      nodeOutcome('mergeGate', 'recheck'),
      nodeOutcome('mergeRecheckRouter', 'clean'),
    ],
  ),
  recoveryGraphScenario(
    'RG-E-ci-loop-recovery',
    [
      nodeOutcome('prRouter', 'ci_changes'),
      nodeDefault('prRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
  ),
  recoveryGraphScenario(
    'RG-F-unknown-then-clean',
    [
      nodeOutcome('prRouter', 'recheck'),
      nodeOutcome('prRouter', 'clean'),
      nodeOutcome('mergeReadinessRouter', 'clean'),
      nodeOutcome('mergeGate', 'approved'),
      nodeOutcome('mergeApproveReverifyRouter', 'clean'),
    ],
    [
      nodeOutcome('prRouter', 'recheck'),
      nodeOutcome('prRouter', 'clean'),
      nodeOutcome('mergeReadinessRouter', 'clean'),
    ],
  ),
  recoveryGraphScenario(
    'RG-G-stale-reverify-recovery',
    [
      nodeCatch('mergeApproveReverify', 'revo.ScriptBlocked'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
    [nodeCatch('mergeApproveReverify', 'revo.ScriptBlocked')],
  ),
  targetContractScenario(
    'TC-272-no-checks-clean',
    [
      nodeOutcome('prRouter', 'clean'),
      nodeOutcome('mergeReadinessRouter', 'clean'),
      nodeOutcome('mergeGate', 'cancel'),
    ],
    [],
  ),
  targetContractScenario(
    'TC-272-never-settling-recovery',
    [
      nodeOutcome('prRouter', 'recheck'),
      nodeDefault('prRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
    [],
  ),
  targetContractScenario(
    'TC-272-unclassifiable-recovery',
    [
      nodeDefault('recoveryRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
    [nodeDefault('recoveryRouter')],
  ),
  targetContractScenario(
    'TC-273-externally-merged',
    [
      nodeOutcome('prRouter', 'merged'),
    ],
  ),
  targetContractScenario(
    'TC-273-externally-closed',
    [
      nodeOutcome('prRouter', 'closed'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
    [nodeOutcome('prRouter', 'closed')],
  ),
  targetContractScenario(
    'TC-274-head-moved-reopens-merge-gate',
    [
      nodeOutcome('mergeGate', 'approved'),
      nodeOutcome('mergeGate', 'cancel'),
    ],
    [],
  ),
  targetContractScenario(
    'TC-275-graphql-outage-recovery',
    [
      nodeCatch('pollPr', 'revo.ScriptFailed'),
      nodeDefault('recoveryRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
    [nodeCatch('pollPr', 'revo.ScriptFailed')],
  ),
  targetContractScenario(
    'TC-276-question-fix',
    [
      nodeOutcome('prRouter', 'review_changes'),
      nodeOutcome('triageRouter', 'question'),
      nodeOutcome('questionGate', 'fix'),
    ],
  ),
  targetContractScenario(
    'TC-276-question-wontfix',
    [
      nodeOutcome('prRouter', 'review_changes'),
      nodeOutcome('triageRouter', 'question'),
      nodeOutcome('questionGate', 'wontfix'),
    ],
    [nodeOutcome('questionGate', 'wontfix')],
  ),
  targetContractScenario(
    'TC-277-cleanup-dirty-preserve',
    [
      nodeOutcome('mergeGate', 'approved'),
      nodeOutcome('mergeApproveReverifyRouter', 'clean'),
    ],
    [],
  ),
  targetContractScenario(
    'TC-279-override-advisory-thread',
    [
      nodeOutcome('mergeGate', 'override_merge'),
      nodeOutcome('overrideMergeRouter', 'clean'),
    ],
    [],
  ),
  runnerRetryGateScenario(
    'RG234-D-agent-question-resume',
    [],
  ),
  seedDefaultPlaybookScenario(
    'M1-profile-single',
    { pipelineId: 'feature-development', profileId: 'codex-standard' },
    [
      profileSignature('codex-standard', 'single-review'),
      nodeOutcome('planReviewRouter', 'approved'),
      nodeOutcome('planGate', 'approved'),
      nodeOutcome('codeReviewRouter', 'approved'),
      nodeOutcome('mergeGate', 'approved'),
    ],
    [
      profileSignature('codex-standard', 'single-review'),
      nodeOutcome('planReviewRouter', 'approved'),
      nodeOutcome('planGate', 'approved'),
      nodeOutcome('codeReviewRouter', 'approved'),
    ],
  ),
  seedDefaultPlaybookScenario(
    'M1b-profile-consensus-rework',
    { pipelineId: 'feature-development', profileId: 'codex-primary-claude-review-consensus' },
    [
      profileSignature('codex-primary-claude-review-consensus', 'dual-consensus-review'),
      nodeOutcome('planReviewRouter', 'changes_requested'),
      nodeOutcome('planReviewRouter', 'approved'),
      nodeOutcome('planGate', 'approved'),
      nodeOutcome('codeReviewRouter', 'approved'),
      nodeOutcome('mergeGate', 'approved'),
    ],
    [
      profileSignature('codex-primary-claude-review-consensus', 'dual-consensus-review'),
      nodeOutcome('planReviewRouter', 'changes_requested'),
    ],
  ),
  seedDefaultPlaybookScenario(
    'M2-profile-local-change',
    { pipelineId: 'local-change', profileId: 'local-change-codex-standard' },
    [
      profileSignature('local-change-codex-standard', 'developer-single'),
    ],
  ),
  seedDefaultPlaybookScenario(
    'M3-profile-analysis-only',
    { pipelineId: 'analysis-only', profileId: 'analysis-only-codex-standard' },
    [
      profileSignature('analysis-only-codex-standard', 'analyst-single'),
    ],
  ),
] as const;

export type PipelineCoverageScenarioId = (typeof PIPELINE_DSL_COVERAGE_SCENARIOS)[number]['id'];

const PIPELINE_COVERAGE_OWNERSHIP: readonly PipelineCoverageOwnershipDeclaration[] = [
  staticPolicy('DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING', [
    ...nodeOutcomes('planReviewRouter', ['approved', 'clean', 'blocker', 'changes_requested']),
    nodeDefault('planReviewRouter'),
    ...nodeOutcomes('planGate', ['approved', 'rework', 'cancel']),
    nodeDefault('planGate'),
    ...nodeOutcomes('planStuckGate', ['approved', 'rework', 'cancel']),
    nodeDefault('planStuckGate'),
    ...nodeOutcomes('codeReviewRouter', ['approved', 'clean', 'blocker', 'changes_requested']),
    nodeDefault('codeReviewRouter'),
    ...nodeOutcomes('codeStuckGate', ['approve_anyway', 'rework', 'cancel']),
    nodeDefault('codeStuckGate'),
    nodeOutcome('prRouter', 'recheck'),
    nodeOutcome('mergeReadinessRouter', 'recheck'),
  ], [
    ...nodeOutcomes('planReviewRouter', ['clean', 'blocker']),
    nodeDefault('planReviewRouter'),
    ...nodeOutcomes('planGate', ['rework', 'cancel']),
    nodeDefault('planGate'),
    ...nodeOutcomes('planStuckGate', ['approved', 'rework', 'cancel']),
    nodeDefault('planStuckGate'),
    ...nodeOutcomes('codeReviewRouter', ['clean', 'blocker', 'changes_requested']),
    nodeDefault('codeReviewRouter'),
    ...nodeOutcomes('codeStuckGate', ['approve_anyway', 'rework', 'cancel']),
    nodeDefault('codeStuckGate'),
    nodeOutcome('mergeReadinessRouter', 'recheck'),
  ]),
  staticPolicy('DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING', [
    ...nodeOutcomes('prRouter', ['clean', 'merged', 'closed']),
    ...nodeOutcomes('mergeReadinessRouter', ['clean', 'merged', 'closed']),
  ], [
    ...nodeOutcomes('mergeReadinessRouter', ['merged', 'closed']),
  ]),
  staticPolicy('DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING', [
    nodeOutcome('prRouter', 'ci_changes'),
    nodeOutcome('mergeReadinessRouter', 'ci_changes'),
  ], [
    nodeOutcome('mergeReadinessRouter', 'ci_changes'),
  ]),
  staticPolicy('DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING', [
    nodeOutcome('prRouter', 'review_changes'),
    nodeOutcome('mergeReadinessRouter', 'review_changes'),
    ...nodeOutcomes('triageRouter', ['question', 'fix', 'wontfix']),
    ...nodeOutcomes('questionGate', ['fix', 'wontfix', 'cancel']),
    nodeDefault('questionGate'),
  ], [
    nodeOutcome('mergeReadinessRouter', 'review_changes'),
    ...nodeOutcomes('triageRouter', ['fix', 'wontfix']),
    nodeOutcome('questionGate', 'cancel'),
    nodeDefault('questionGate'),
  ]),
  staticPolicy('DEFAULT_POLICY_APPROVE_REVERIFY_MISSING', [
    nodeOutcome('mergeGate', 'approved'),
    ...nodeOutcomes('mergeApproveReverifyRouter', ['clean', 'merged', 'closed']),
    nodeDefault('mergeApproveReverifyRouter'),
  ], [
    ...nodeOutcomes('mergeApproveReverifyRouter', ['merged', 'closed']),
    nodeDefault('mergeApproveReverifyRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING', [
    ...nodeOutcomes('mergeGate', ['recheck', 'address_review_threads', 'return_to_development', 'cancel']),
    ...nodeOutcomes('mergeRecheckRouter', ['clean', 'merged', 'closed', 'review_changes', 'ci_changes', 'recheck']),
    nodeDefault('mergeRecheckRouter'),
  ], [
    ...nodeOutcomes('mergeGate', ['address_review_threads', 'return_to_development']),
    ...nodeOutcomes('mergeRecheckRouter', ['merged', 'closed', 'review_changes', 'ci_changes', 'recheck']),
    nodeDefault('mergeRecheckRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_OVERRIDE_MERGE_ROUTE_MISSING', [
    nodeOutcome('mergeGate', 'override_merge'),
    ...nodeOutcomes('overrideMergeRouter', ['clean', 'merged', 'closed']),
    nodeDefault('overrideMergeRouter'),
  ], [
    ...nodeOutcomes('overrideMergeRouter', ['merged', 'closed']),
    nodeDefault('overrideMergeRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT', [
    ...nodeOutcomes('recoveryGate', ['recheck', 'cancel']),
    nodeDefault('mergeGate'),
    nodeDefault('recoveryGate'),
  ], [
    nodeOutcome('recoveryGate', 'recheck'),
    nodeDefault('mergeGate'),
    nodeDefault('recoveryGate'),
  ]),
  staticPolicy('DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING', [
    nodeDefault('prRouter'),
    nodeDefault('mergeReadinessRouter'),
    nodeDefault('mergeRecheckRouter'),
    nodeDefault('overrideMergeRouter'),
    nodeDefault('triageRouter'),
    nodeDefault('recoveryRouter'),
    nodeDefault('planReviewRouter'),
    nodeDefault('codeReviewRouter'),
  ], [
    nodeDefault('mergeReadinessRouter'),
    nodeDefault('triageRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL', [
    ...nodeCatches(PR_LIFECYCLE_NODES.filter((nodeId) => nodeId !== 'confirmMerge' && nodeId !== 'overrideConfirmMerge')),
  ], [
    nodeCatch('integrator', 'revo.ScriptBlocked'),
    nodeCatch('integrator', 'revo.ScriptFailed'),
    nodeCatch('mergeApproveReverify', 'revo.ScriptFailed'),
    ...nodeCatches(['mergeReadiness', 'mergeRecheck', 'overrideMerge']),
    nodeCatch('pollPr', 'revo.ScriptBlocked'),
    ...nodeCatches(['questionReviewIntegrator', 'respondThreads', 'reviewIntegrator']),
  ]),
  staticPolicy('DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL', [
    ...nodeCatches(['confirmMerge', 'overrideConfirmMerge']),
  ], [
    ...nodeCatches(['confirmMerge', 'overrideConfirmMerge']),
  ]),
  staticPolicy('DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING', [
    ...nodeCatches(['cleanupWorktree']),
  ], [
    ...nodeCatches(['cleanupWorktree']),
  ]),
  unit('src/control-plane/run-profiles.test.ts', [SINGLE_REVIEW_PROFILE_TAGS[0]], [SINGLE_REVIEW_PROFILE_TAGS[0]], [
    { pipelineId: 'feature-development', profileId: 'claude-standard' },
  ]),
  unit('src/control-plane/run-profiles.test.ts', [CONSENSUS_PROFILE_TAGS[1]], [CONSENSUS_PROFILE_TAGS[1]], [
    { pipelineId: 'feature-development', profileId: 'claude-primary-codex-review-consensus' },
  ]),
  unit('src/control-plane/run-profiles.test.ts', [LOCAL_CHANGE_PROFILE_TAGS[0]], [LOCAL_CHANGE_PROFILE_TAGS[0]], [
    { pipelineId: 'local-change', profileId: 'local-change-claude-standard' },
  ]),
  unit('src/control-plane/run-profiles.test.ts', [ANALYSIS_ONLY_PROFILE_TAGS[0]], [ANALYSIS_ONLY_PROFILE_TAGS[0]], [
    { pipelineId: 'analysis-only', profileId: 'analysis-only-claude-standard' },
  ]),
  unit('src/pipeline-core/interpret.test.ts', [
    nodeOutcome('recoveryRouter', 'fix'),
  ], [
    nodeOutcome('recoveryRouter', 'fix'),
  ], FEATURE_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING', [
    nodeOutcome('codeReviewRouter', 'approved'),
    nodeOutcome('planGate', 'approved'),
    nodeOutcome('planReviewRouter', 'approved'),
  ], FEATURE_STATIC_APPROVAL_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING', [
    nodeOutcome('planReviewRouter', 'changes_requested'),
  ], FEATURE_STATIC_REWORK_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING', [
    nodeOutcome('prRouter', 'recheck'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING', [
    ...nodeOutcomes('prRouter', ['clean', 'merged', 'closed']),
    nodeOutcome('mergeReadinessRouter', 'clean'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING', [
    nodeOutcome('prRouter', 'ci_changes'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING', [
    nodeOutcome('prRouter', 'review_changes'),
    nodeOutcome('triageRouter', 'question'),
    ...nodeOutcomes('questionGate', ['fix', 'wontfix']),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_APPROVE_REVERIFY_MISSING', [
    nodeOutcome('mergeGate', 'approved'),
    nodeOutcome('mergeApproveReverifyRouter', 'clean'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING', [
    ...nodeOutcomes('mergeGate', ['cancel', 'recheck']),
    nodeOutcome('mergeRecheckRouter', 'clean'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_OVERRIDE_MERGE_ROUTE_MISSING', [
    nodeOutcome('mergeGate', 'override_merge'),
    nodeOutcome('overrideMergeRouter', 'clean'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT', [
    nodeOutcome('recoveryGate', 'cancel'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_CAP_EXHAUSTION_OFFRAMP_MISSING', [
    nodeDefault('prRouter'),
    nodeDefault('recoveryRouter'),
  ], FEATURE_SIBLING_MATERIALIZED),
  staticPolicyPrimaryOwnership('DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL', [
    nodeCatch('mergeApproveReverify', 'revo.ScriptBlocked'),
    nodeCatch('pollPr', 'revo.ScriptFailed'),
  ], FEATURE_SIBLING_MATERIALIZED),
] as const;

const PIPELINE_COVERAGE_WAIVERS: readonly PipelineCoverageWaiverDeclaration[] = [] as const;

export function coverageForScenario(scenarioId: PipelineCoverageScenarioId): PipelineScenarioCoverage {
  const attachment = registeredPipelineAttachmentLookup.get(scenarioId);
  if (!attachment) throw new Error(`unknown pipeline coverage scenario: ${scenarioId}`);
  return attachment;
}

export function graphCoverageTagsForTemplate(template: Template): PipelineCoverageTag[] {
  const tags = new Set<PipelineCoverageTag>();
  for (const [nodeId, node] of Object.entries(template.nodes)) {
    if (node.kind === 'humanGate') {
      for (const outcome of node.outcomes) tags.add(nodeOutcome(nodeId, outcome));
      addBranchTags(tags, nodeId, node.branches);
      continue;
    }
    if (node.kind === 'choice') {
      addBranchTags(tags, nodeId, node.branches);
      continue;
    }
    if (node.kind === 'agent' || node.kind === 'script') {
      for (const entry of node.catch ?? []) tags.add(nodeCatch(nodeId, entry.onError));
    }
  }
  return [...tags].sort(compareStrings);
}

export function profileCoverageTag(profile: RunProfileCoverageInput): PipelineCoverageTag {
  return profileSignature(profile.id, routingSignatureForRunProfile(profile));
}

export function routingSignatureForRunProfile(profile: RunProfileCoverageInput): string {
  const stages = asRecord(asRecord(profile.topology).stages);
  const stageEntries = Object.entries(stages)
    .map(([stage, config]) => [stage, stageSignature(config)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = stageEntries.map(([stage, signature]) => `${stage}:${signature}`).join('|');
  if (canonical === 'codeReview:single|planReviewer:single') return 'single-review';
  if (canonical === 'codeReview:consensus2|planReviewer:consensus2') return 'dual-consensus-review';
  return stageEntries.map(([stage, signature]) => `${stage}-${signature}`).join('__') || 'no-review-stages';
}

export function derivePipelineCoverageCatalog(
  pipelines: readonly PipelineCatalogCoverageInput[],
  runProfiles: readonly RunProfileCoverageInput[],
): DerivedPipelineCoverageCatalog {
  const materialized: MaterializedCoverageIdentity[] = [];
  const cells = new Map<PipelineCoverageCellId, PipelineCoverageCell>();
  const templates = new Map<string, Template>();
  for (const pipeline of pipelines) {
    const template = pipeline.execution_policy?.template_json;
    if (!template) continue;
    templates.set(pipeline.id, template);
    const identity = {
      pipelineId: pipeline.id,
      profileId: 'base',
      materializedTemplateHash: hashTemplate(template),
      routingSignature: 'base',
    } satisfies MaterializedCoverageIdentity;
    materialized.push(identity);
    addCoverageCells(cells, identity, graphCoverageTagsForTemplate(template));
  }
  for (const profile of runProfiles) {
    if (profile.status !== undefined && profile.status !== 'active') continue;
    const routingSignature = routingSignatureForRunProfile(profile);
    const base = templates.get(profile.pipelineId);
    if (!base) throw new Error(`cannot derive coverage cells for profile ${profile.id}: base pipeline is missing`);
    const result = materializeTemplate(
      base,
      topologyProfileFromRunProfile(profile as unknown as Record<string, unknown>, {
        profileId: profile.id,
        pipelineId: profile.pipelineId,
      }),
      { allowlist: ['planReviewer', 'codeReview'] },
    );
    if (result.diagnostics.length > 0) {
      throw new Error(
        `cannot derive coverage cells for profile ${profile.id}: ${result.diagnostics.map((item) => item.code).join(', ')}`,
      );
    }
    const identity = {
      pipelineId: profile.pipelineId,
      profileId: profile.id,
      materializedTemplateHash: result.materializedTemplateHash,
      routingSignature,
    } satisfies MaterializedCoverageIdentity;
    materialized.push(identity);
    addCoverageCells(cells, identity, [
      ...graphCoverageTagsForTemplate(result.template),
      profileSignature(profile.id, routingSignature),
    ]);
  }
  const sortedMaterialized = materialized.toSorted((left, right) =>
    materializedCoverageKey(left).localeCompare(materializedCoverageKey(right)));
  const sortedCells = [...cells.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    catalogIdentity: createHash('sha256')
      .update(JSON.stringify(sortedMaterialized.map(materializedCoverageKey)))
      .digest('hex'),
    tags: [...new Set(sortedCells.map((cell) => cell.tag))].sort(compareStrings),
    materialized: sortedMaterialized,
    cells: sortedCells,
  };
}

function addCoverageCells(
  cells: Map<PipelineCoverageCellId, PipelineCoverageCell>,
  materialized: MaterializedCoverageIdentity,
  tags: readonly PipelineCoverageTag[],
): void {
  for (const tag of tags) {
    const id = `${materializedCoverageKey(materialized)}::${tag}` as PipelineCoverageCellId;
    cells.set(id, { id, tag, materialized });
  }
}

function materializedCoverageKey(identity: MaterializedCoverageIdentity): string {
  return [
    identity.pipelineId,
    identity.profileId,
    identity.materializedTemplateHash,
    identity.routingSignature,
  ].join('::');
}

export function definePipelineCoverageRegistry(
  input: PipelineCoverageRegistryInput,
  catalog: DerivedPipelineCoverageCatalog = bundledCoverageCatalog,
): PipelineCoverageRegistry {
  const registry: PipelineCoverageRegistry = Object.freeze({
    scenarios: Object.freeze(input.scenarios.map((scenario) => {
      const materialized = resolveMaterializedIdentity(catalog, scenario.materialized);
      return Object.freeze({
        id: scenario.id,
        ownerSurface: scenario.ownerSurface,
        tags: Object.freeze([...scenario.tags]),
        primaryTags: Object.freeze([...scenario.primaryTags]),
        materialized,
        cellIds: Object.freeze(cellIdsFor(materialized, scenario.tags)),
        primaryCellIds: Object.freeze(cellIdsFor(materialized, scenario.primaryTags)),
      });
    })),
    ownership: Object.freeze(input.ownership.map((ownership) => {
      const materialized = Object.freeze(ownership.materialized.map((selector) =>
        resolveMaterializedIdentity(catalog, selector)));
      return Object.freeze({
        owner: ownership.owner,
        ownerSurface: ownership.ownerSurface,
        tags: Object.freeze([...ownership.tags]),
        primaryTags: Object.freeze([...ownership.primaryTags]),
        materialized,
        cellIds: Object.freeze(materialized.flatMap((identity) => cellIdsFor(identity, ownership.tags))),
        primaryCellIds: Object.freeze(materialized.flatMap((identity) =>
          cellIdsFor(identity, ownership.primaryTags))),
        ...(ownership.diagnosticCode === undefined ? {} : { diagnosticCode: ownership.diagnosticCode }),
      });
    })),
    waivers: Object.freeze(input.waivers.map((waiver) => {
      const materialized = Object.freeze((waiver.materialized ?? []).map((selector) =>
        resolveMaterializedIdentity(catalog, selector)));
      const tags = waiver.tags === undefined ? undefined : Object.freeze([...waiver.tags]);
      return Object.freeze({
        id: waiver.id,
        reason: waiver.reason,
        ownerSurface: waiver.ownerSurface,
        tags,
        materialized,
        cellIds: Object.freeze(materialized.flatMap((identity) => cellIdsFor(identity, tags ?? []))),
        expiry: waiver.expiry === undefined ? undefined : Object.freeze({
          ...(waiver.expiry.stage === undefined ? {} : { stage: waiver.expiry.stage }),
          ...(waiver.expiry.condition === undefined ? {} : { condition: waiver.expiry.condition }),
        }),
      });
    })),
  });
  const duplicate = [...primaryClaims(registry).entries()].find(([, claims]) => claims.length > 1);
  if (duplicate) {
    const [cellId, claims] = duplicate;
    throw new Error(`multiple primary owners for ${cellId}: ${claims.join(', ')}`);
  }
  validatePrimaryTagsBelongToDeclarations(registry);
  return registry;
}

function resolveMaterializedIdentity(
  catalog: DerivedPipelineCoverageCatalog,
  selector: MaterializedCoverageSelector,
): MaterializedCoverageIdentity {
  const identity = catalog.materialized.find((candidate) =>
    candidate.pipelineId === selector.pipelineId && candidate.profileId === selector.profileId);
  if (!identity) {
    throw new Error(`unknown materialized coverage identity: ${selector.pipelineId}/${selector.profileId}`);
  }
  return Object.freeze({ ...identity });
}

function cellIdsFor(
  materialized: MaterializedCoverageIdentity,
  tags: readonly PipelineCoverageTag[],
): PipelineCoverageCellId[] {
  return tags.map((tag) => pipelineCoverageCellId(materialized, tag)).sort((left, right) =>
    String(left).localeCompare(String(right)));
}

export function pipelineCoverageCellId(
  materialized: MaterializedCoverageIdentity,
  tag: PipelineCoverageTag,
): PipelineCoverageCellId {
  return `${materializedCoverageKey(materialized)}::${tag}` as PipelineCoverageCellId;
}

function validatePrimaryTagsBelongToDeclarations(registry: PipelineCoverageRegistry): void {
  for (const scenario of registry.scenarios) {
    for (const tag of scenario.primaryTags) {
      if (!scenario.tags.includes(tag)) {
        throw new Error(`primary coverage tag ${tag} is not declared by scenario ${scenario.id}`);
      }
    }
  }
  for (const ownership of registry.ownership) {
    for (const tag of ownership.primaryTags) {
      if (!ownership.tags.includes(tag)) {
        throw new Error(`primary coverage tag ${tag} is not declared by ${ownership.owner}:${ownership.ownerSurface}`);
      }
    }
  }
}

function primaryClaims(registry: PipelineCoverageRegistry): Map<PipelineCoverageCellId, string[]> {
  const claims = new Map<PipelineCoverageCellId, string[]>();
  for (const scenario of registry.scenarios) {
    for (const cellId of scenario.primaryCellIds) addPrimaryClaim(claims, cellId, `scenario:${scenario.id}`);
  }
  for (const ownership of registry.ownership) {
    for (const cellId of ownership.primaryCellIds) {
      addPrimaryClaim(claims, cellId, `${ownership.owner}:${ownership.ownerSurface}`);
    }
  }
  return claims;
}

function addPrimaryClaim(
  claims: Map<PipelineCoverageCellId, string[]>,
  cellId: PipelineCoverageCellId,
  owner: string,
): void {
  const owners = claims.get(cellId) ?? [];
  owners.push(owner);
  claims.set(cellId, owners);
}

function definePipelineCoverageManifest(
  registry: PipelineCoverageRegistry,
  pipelines: readonly PipelineCatalogCoverageInput[],
  runProfiles: readonly RunProfileCoverageInput[],
): DefinedPipelineCoverageManifest {
  const catalog = derivePipelineCoverageCatalog(pipelines, runProfiles);
  for (const identity of catalog.materialized) Object.freeze(identity);
  for (const cell of catalog.cells) Object.freeze(cell);
  Object.freeze(catalog.tags);
  Object.freeze(catalog.materialized);
  Object.freeze(catalog.cells);
  Object.freeze(catalog);
  const attachmentLookup = new Map<PipelineCoverageScenarioId, PipelineScenarioCoverage>();
  for (const scenario of registry.scenarios) {
    const scenarioId = scenario.id as PipelineCoverageScenarioId;
    attachmentLookup.set(scenarioId, Object.freeze({
      kind: 'registered-dsl',
      scenarioId,
      ownerSurface: scenario.ownerSurface,
      tags: Object.freeze([...scenario.tags]),
      primaryTags: Object.freeze([...scenario.primaryTags]),
      catalogIdentity: catalog.catalogIdentity,
      materialized: Object.freeze({ ...scenario.materialized }),
      cellIds: Object.freeze([...scenario.cellIds]),
      primaryCellIds: Object.freeze([...scenario.primaryCellIds]),
    }));
  }
  const attachments = Object.freeze([...attachmentLookup.values()]);
  return Object.freeze({
    publicManifest: Object.freeze({ registry, catalog, attachments }),
    attachmentLookup,
  });
}

function readBundledCoverageInput<T>(filename: string): T {
  return JSON.parse(readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog', filename), 'utf8')) as T;
}

const bundledPipelines = readBundledCoverageInput<PipelineCatalogCoverageInput[]>('pipelines.json');
const bundledRunProfiles = readBundledCoverageInput<RunProfileCoverageInput[]>('run-profiles.json');
const bundledCoverageCatalog = derivePipelineCoverageCatalog(bundledPipelines, bundledRunProfiles);

export const PIPELINE_COVERAGE_REGISTRY: PipelineCoverageRegistry = definePipelineCoverageRegistry({
  scenarios: PIPELINE_DSL_COVERAGE_SCENARIOS,
  ownership: PIPELINE_COVERAGE_OWNERSHIP,
  waivers: PIPELINE_COVERAGE_WAIVERS,
}, bundledCoverageCatalog);

const definedPipelineCoverageManifest = definePipelineCoverageManifest(
  PIPELINE_COVERAGE_REGISTRY,
  bundledPipelines,
  bundledRunProfiles,
);
const registeredPipelineAttachmentLookup = definedPipelineCoverageManifest.attachmentLookup;
export const PIPELINE_COVERAGE_MANIFEST = definedPipelineCoverageManifest.publicManifest;

export function materializedCoverageIdentity(
  pipelineId: string,
  profileId: string,
): MaterializedCoverageIdentity {
  const identity = PIPELINE_COVERAGE_MANIFEST.catalog.materialized.find((candidate) =>
    candidate.pipelineId === pipelineId && candidate.profileId === profileId);
  if (!identity) throw new Error(`unknown pinned materialized coverage identity: ${pipelineId}/${profileId}`);
  return identity;
}

function sameMaterializedIdentity(
  left: MaterializedCoverageIdentity,
  right: MaterializedCoverageIdentity,
): boolean {
  return left.pipelineId === right.pipelineId &&
    left.profileId === right.profileId &&
    left.materializedTemplateHash === right.materializedTemplateHash &&
    left.routingSignature === right.routingSignature;
}

export function validatePipelineCaseAttachment(
  attachment: PipelineCaseAttachment,
  selectedMaterialized?: MaterializedCoverageIdentity,
): void {
  if (attachment.kind === 'non-dsl') {
    validateNonDslPipelineCaseAttachment(attachment);
    return;
  }
  if (registeredPipelineAttachmentLookup.get(attachment.scenarioId) !== attachment) {
    throw new Error('registered pipeline attachment does not match the pinned manifest');
  }
  if (!selectedMaterialized || !sameMaterializedIdentity(attachment.materialized, selectedMaterialized)) {
    throw new Error('registered pipeline attachment does not match the selected materialized identity');
  }
}

export function validatePipelineCoverageRegistry(input: {
  pipelines: readonly PipelineCatalogCoverageInput[];
  runProfiles: readonly RunProfileCoverageInput[];
  registry?: PipelineCoverageRegistry;
  currentStage?: PipelineCoverageStage;
}): PipelineCoverageDiagnostic[] {
  const registry = input.registry ?? PIPELINE_COVERAGE_REGISTRY;
  const catalog = derivePipelineCoverageCatalog(input.pipelines, input.runProfiles);
  const definedCells = new Map(catalog.cells.map((cell) => [cell.id, cell]));
  const ownedCells = new Set<PipelineCoverageCellId>();
  const dslPrimaryCells = new Set<PipelineCoverageCellId>();
  const ownerClaims = new Map<PipelineCoverageCellId, string[]>();
  const diagnostics: PipelineCoverageDiagnostic[] = [];

  addScenarioDiagnostics(diagnostics, definedCells, ownedCells, dslPrimaryCells, ownerClaims, registry.scenarios);
  addOwnershipDiagnostics(diagnostics, definedCells, ownedCells, ownerClaims, registry.ownership);
  addOwnershipAlgebraDiagnostics(
    diagnostics,
    ownerClaims,
    registry.waivers,
    input.currentStage ?? 'stage-2',
  );
  addWaiverDiagnostics(diagnostics, definedCells, ownedCells, registry.waivers, input.currentStage ?? 'stage-2');
  addUnownedCellDiagnostics(diagnostics, catalog.cells, ownedCells);
  addProfileRoutingSignatureDiagnostics(
    diagnostics,
    input.runProfiles,
    dslPrimaryCells,
    registry.waivers,
    input.currentStage ?? 'stage-2',
  );

  return diagnostics;
}

function addScenarioDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedCells: ReadonlyMap<PipelineCoverageCellId, PipelineCoverageCell>,
  ownedCells: Set<PipelineCoverageCellId>,
  dslPrimaryCells: Set<PipelineCoverageCellId>,
  ownerClaims: Map<PipelineCoverageCellId, string[]>,
  scenarios: readonly PipelineDslCoverageScenario[],
): void {
  for (const scenario of scenarios) {
    addDefinedCellDiagnostics(diagnostics, definedCells, scenario.cellIds, {
      scenarioId: scenario.id,
      ownerSurface: scenario.ownerSurface,
    });
    addPrimaryCellClaimDiagnostics(diagnostics, definedCells, ownedCells, ownerClaims, dslPrimaryCells, {
      ownerClaim: `scenario:${scenario.id}`,
      declaration: `scenario ${scenario.id}`,
      evidence: `DSL scenario ${scenario.id}`,
      tags: scenario.tags,
      primaryTags: scenario.primaryTags,
      materialized: [scenario.materialized],
      cellIds: scenario.cellIds,
      primaryCellIds: scenario.primaryCellIds,
      context: { scenarioId: scenario.id, ownerSurface: scenario.ownerSurface },
    });
  }
}

function addOwnershipDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedCells: ReadonlyMap<PipelineCoverageCellId, PipelineCoverageCell>,
  ownedCells: Set<PipelineCoverageCellId>,
  ownerClaims: Map<PipelineCoverageCellId, string[]>,
  ownership: readonly PipelineCoverageOwnership[],
): void {
  for (const owner of ownership) {
    addDefinedCellDiagnostics(diagnostics, definedCells, owner.cellIds, {
      ownerSurface: owner.ownerSurface,
    });
    addPrimaryCellClaimDiagnostics(diagnostics, definedCells, ownedCells, ownerClaims, undefined, {
      ownerClaim: `${owner.owner}:${owner.ownerSurface}`,
      declaration: `${owner.owner}:${owner.ownerSurface}`,
      evidence: `${owner.owner} evidence ${owner.ownerSurface}`,
      tags: owner.tags,
      primaryTags: owner.primaryTags,
      materialized: owner.materialized,
      cellIds: owner.cellIds,
      primaryCellIds: owner.primaryCellIds,
      context: { ownerSurface: owner.ownerSurface },
    });
  }
}

type PrimaryCellClaim = Readonly<{
  ownerClaim: string;
  declaration: string;
  evidence: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  materialized: readonly MaterializedCoverageIdentity[];
  cellIds: readonly PipelineCoverageCellId[];
  primaryCellIds: readonly PipelineCoverageCellId[];
  context: Readonly<{ scenarioId?: string; ownerSurface?: string }>;
}>;

type PrimaryCellClaimDerivation = Readonly<{
  undeclaredPrimaryTags: readonly PipelineCoverageTag[];
  claimedPrimaryCellIds: ReadonlySet<PipelineCoverageCellId>;
  derivedPrimaryCellIds: ReadonlySet<PipelineCoverageCellId>;
  materializedSelectors: string;
}>;

type PrimaryCellClaimValidationState = Readonly<{
  diagnostics: PipelineCoverageDiagnostic[];
  definedCells: ReadonlyMap<PipelineCoverageCellId, PipelineCoverageCell>;
  ownedCells: Set<PipelineCoverageCellId>;
  ownerClaims: Map<PipelineCoverageCellId, string[]>;
  acceptedCells: Set<PipelineCoverageCellId> | undefined;
}>;

function addPrimaryCellClaimDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedCells: ReadonlyMap<PipelineCoverageCellId, PipelineCoverageCell>,
  ownedCells: Set<PipelineCoverageCellId>,
  ownerClaims: Map<PipelineCoverageCellId, string[]>,
  acceptedCells: Set<PipelineCoverageCellId> | undefined,
  claim: PrimaryCellClaim,
): void {
  const derivation = derivePrimaryCellClaim(claim);
  const state = { diagnostics, definedCells, ownedCells, ownerClaims, acceptedCells };
  addUndeclaredPrimaryTagDiagnostics(state, claim, derivation);
  addDerivedPrimaryCellClaimDiagnostics(state, claim, derivation);
  addSuppliedPrimaryCellClaimDiagnostics(state, claim, derivation);
}

function derivePrimaryCellClaim(claim: PrimaryCellClaim): PrimaryCellClaimDerivation {
  const undeclaredPrimaryTags = claim.primaryTags.filter((tag) => !claim.tags.includes(tag));
  const declaredPrimaryTags = claim.primaryTags.filter((tag) => !undeclaredPrimaryTags.includes(tag));
  return {
    undeclaredPrimaryTags,
    claimedPrimaryCellIds: new Set(claim.materialized.flatMap((identity) =>
      cellIdsFor(identity, claim.primaryTags))),
    derivedPrimaryCellIds: new Set(claim.materialized.flatMap((identity) =>
      cellIdsFor(identity, declaredPrimaryTags))),
    materializedSelectors: claim.materialized
      .map((identity) => `${identity.pipelineId}/${identity.profileId}`)
      .toSorted(compareStrings)
      .join(', '),
  };
}

function addUndeclaredPrimaryTagDiagnostics(
  state: PrimaryCellClaimValidationState,
  claim: PrimaryCellClaim,
  derivation: PrimaryCellClaimDerivation,
): void {
  for (const tag of derivation.undeclaredPrimaryTags) {
    state.diagnostics.push({
      code: 'PIPELINE_COVERAGE_INCONSISTENT_PRIMARY_CLAIM',
      message: `primary coverage tag ${tag} is not declared by ${claim.evidence} tags`,
      tag,
      ...claim.context,
    });
  }
}

function addDerivedPrimaryCellClaimDiagnostics(
  state: PrimaryCellClaimValidationState,
  claim: PrimaryCellClaim,
  derivation: PrimaryCellClaimDerivation,
): void {
  for (const cellId of derivation.derivedPrimaryCellIds) {
    if (!state.definedCells.has(cellId)) {
      if (!claim.cellIds.includes(cellId)) {
        state.diagnostics.push({
          code: 'PIPELINE_COVERAGE_UNDEFINED_CELL',
          message: `coverage cell ${cellId} derived from ${claim.evidence} primary tags is not defined by the selected materialized catalog`,
          cellId,
          tag: tagFromCellId(cellId),
          ...claim.context,
        });
      }
      continue;
    }
    state.ownedCells.add(cellId);
    addPrimaryClaim(state.ownerClaims, cellId, claim.ownerClaim);
    if (!claim.primaryCellIds.includes(cellId)) {
      state.diagnostics.push({
        code: 'PIPELINE_COVERAGE_INCONSISTENT_PRIMARY_CLAIM',
        message: `primary coverage cell ${cellId} derived from ${claim.evidence} primary tags under ${derivation.materializedSelectors} is missing from primaryCellIds`,
        cellId,
        tag: tagFromCellId(cellId),
        ...claim.context,
      });
      continue;
    }
    if (claim.cellIds.includes(cellId)) state.acceptedCells?.add(cellId);
  }
}

function addSuppliedPrimaryCellClaimDiagnostics(
  state: PrimaryCellClaimValidationState,
  claim: PrimaryCellClaim,
  derivation: PrimaryCellClaimDerivation,
): void {
  for (const cellId of claim.primaryCellIds) {
    const declared = claim.cellIds.includes(cellId);
    if (!declared) {
      state.diagnostics.push({
        code: 'PIPELINE_COVERAGE_UNDEFINED_CELL',
        message: `primary coverage cell ${cellId} is not declared by ${claim.declaration}`,
        cellId,
        tag: tagFromCellId(cellId),
        ...claim.context,
      });
    }
    const consistent = derivation.derivedPrimaryCellIds.has(cellId);
    if (!consistent && !derivation.claimedPrimaryCellIds.has(cellId)) {
      state.diagnostics.push({
        code: 'PIPELINE_COVERAGE_INCONSISTENT_PRIMARY_CLAIM',
        message: `primary coverage cell ${cellId} is not derived from ${claim.evidence} primary tags under ${derivation.materializedSelectors}`,
        cellId,
        tag: tagFromCellId(cellId),
        ...claim.context,
      });
    }
  }
}

function addWaiverDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedCells: ReadonlyMap<PipelineCoverageCellId, PipelineCoverageCell>,
  ownedCells: Set<PipelineCoverageCellId>,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: PipelineCoverageStage,
): void {
  for (const waiver of waivers) {
    const complete = isCompleteCoverageWaiver(waiver);
    if (!complete) addIncompleteWaiverDiagnostic(diagnostics, waiver);
    const expired = complete && isExpiredCoverageWaiver(waiver, currentStage);
    if (expired) {
      diagnostics.push({
        code: 'PIPELINE_COVERAGE_EXPIRED_WAIVER',
        message: `coverage waiver ${waiver.id} expired at ${waiver.expiry?.stage}`,
        waiverId: waiver.id,
      });
    }
    addDefinedCellDiagnostics(diagnostics, definedCells, waiver.cellIds, {
      waiverId: waiver.id,
      ownerSurface: waiver.ownerSurface,
    });
    if (complete && !expired) addOwnedCells(ownedCells, waiver.cellIds);
  }
}

function addOwnershipAlgebraDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  ownerClaims: ReadonlyMap<PipelineCoverageCellId, string[]>,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: PipelineCoverageStage,
): void {
  const waiverClaims = new Map<PipelineCoverageCellId, string[]>();
  for (const waiver of waivers) {
    if (!isCompleteCoverageWaiver(waiver) || isExpiredCoverageWaiver(waiver, currentStage)) continue;
    for (const cellId of waiver.cellIds) {
      const claims = waiverClaims.get(cellId) ?? [];
      claims.push(waiver.id);
      waiverClaims.set(cellId, claims);
    }
  }

  for (const [cellId, claims] of ownerClaims) {
    if (claims.length > 1) {
      diagnostics.push({
        code: 'PIPELINE_COVERAGE_DUPLICATE_OWNER',
        message: `coverage cell ${cellId} has multiple primary owners: ${claims.join(', ')}`,
        cellId,
        tag: tagFromCellId(cellId),
      });
    }
    if (waiverClaims.has(cellId)) {
      diagnostics.push({
        code: 'PIPELINE_COVERAGE_OWNED_AND_WAIVED',
        message: `coverage cell ${cellId} is both owned and waived`,
        cellId,
        tag: tagFromCellId(cellId),
      });
    }
  }
  for (const [cellId, claims] of waiverClaims) {
    if (claims.length <= 1) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_DUPLICATE_OWNER',
      message: `coverage cell ${cellId} has multiple complete waivers: ${claims.join(', ')}`,
      cellId,
      tag: tagFromCellId(cellId),
    });
  }
}

function addUnownedCellDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedCells: readonly PipelineCoverageCell[],
  ownedCells: ReadonlySet<PipelineCoverageCellId>,
): void {
  for (const cell of definedCells) {
    if (ownedCells.has(cell.id)) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_UNOWNED_CELL',
      message: `coverage cell ${cell.id} has no owner`,
      cellId: cell.id,
      tag: cell.tag,
    });
  }
}

function addProfileRoutingSignatureDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  runProfiles: readonly RunProfileCoverageInput[],
  dslPrimaryCells: ReadonlySet<PipelineCoverageCellId>,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: PipelineCoverageStage,
): void {
  for (const signature of profileRoutingSignatures(runProfiles)) {
    if (isProfileRoutingSignatureCovered(signature, dslPrimaryCells, waivers, currentStage)) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL',
      message: `profile routing signature ${signature} has no DSL scenario owner or waiver`,
    });
  }
}

function addDefinedCellDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedCells: ReadonlyMap<PipelineCoverageCellId, PipelineCoverageCell>,
  cellIds: readonly PipelineCoverageCellId[],
  context: { scenarioId?: string; ownerSurface?: string; waiverId?: string },
): void {
  for (const cellId of cellIds) {
    if (definedCells.has(cellId)) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_UNDEFINED_CELL',
      message: `coverage cell ${cellId} is not defined by the selected materialized catalog`,
      cellId,
      tag: tagFromCellId(cellId),
      ...context,
    });
  }
}

function addOwnedCells(
  ownedCells: Set<PipelineCoverageCellId>,
  cellIds: readonly PipelineCoverageCellId[],
): void {
  for (const cellId of cellIds) ownedCells.add(cellId);
}

function addIncompleteWaiverDiagnostic(
  diagnostics: PipelineCoverageDiagnostic[],
  waiver: PipelineCoverageWaiver,
): void {
  diagnostics.push({
    code: 'PIPELINE_COVERAGE_INCOMPLETE_WAIVER',
    message: `coverage waiver ${waiver.id} must include stable cells, reason, ownerSurface, and expiry stage or condition`,
    waiverId: waiver.id,
  });
}

function isProfileRoutingSignatureCovered(
  signature: string,
  dslPrimaryCells: ReadonlySet<PipelineCoverageCellId>,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: PipelineCoverageStage,
): boolean {
  return hasDslPrimaryCellForSignature(signature, dslPrimaryCells) ||
    hasWaiverForProfileSignature(signature, waivers, currentStage);
}

function hasDslPrimaryCellForSignature(
  signature: string,
  dslPrimaryCells: ReadonlySet<PipelineCoverageCellId>,
): boolean {
  return [...dslPrimaryCells].some((cellId) =>
    profileSignatureFromTag(tagFromCellId(cellId)) === signature);
}

function hasWaiverForProfileSignature(
  signature: string,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: PipelineCoverageStage,
): boolean {
  return waivers.some((waiver) =>
    isCompleteCoverageWaiver(waiver) && !isExpiredCoverageWaiver(waiver, currentStage) &&
    (waiver.tags ?? []).some((tag) => profileSignatureFromTag(tag) === signature),
  );
}

function isCompleteCoverageWaiver(waiver: PipelineCoverageWaiver): boolean {
  const expiryStage = waiver.expiry?.stage;
  const expiryCondition = waiver.expiry?.condition?.trim() ?? '';
  return waiver.reason.trim().length > 0 &&
    waiver.ownerSurface.trim().length > 0 &&
    waiver.cellIds.length > 0 &&
    (expiryStage !== undefined || expiryCondition.length > 0);
}

function isExpiredCoverageWaiver(
  waiver: PipelineCoverageWaiver,
  currentStage: PipelineCoverageStage,
): boolean {
  const stage = waiver.expiry?.stage;
  if (!stage) return false;
  const order = { 'stage-2': 2, 'stage-3': 3, later: 4 } as const;
  return order[stage] <= order[currentStage];
}

function addBranchTags(tags: Set<PipelineCoverageTag>, nodeId: string, branches: readonly Branch[]): void {
  for (const branch of branches) {
    if (isDefaultBranch(branch)) {
      tags.add(nodeDefault(nodeId));
      continue;
    }
    if (isGuardedBranch(branch)) {
      for (const verdict of verdictsInCondition(branch.when)) tags.add(nodeOutcome(nodeId, verdict));
    }
  }
}

function verdictsInCondition(condition: Condition): string[] {
  switch (condition.op) {
    case 'verdict.eq':
      return [condition.value];
    case 'verdict.in':
      return condition.value;
    case 'counter.lt':
    case 'counter.gte':
      return [];
    case 'all':
    case 'any':
      return condition.of.flatMap((child) => verdictsInCondition(child));
    case 'not':
      return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stageSignature(value: unknown): string {
  const stage = asRecord(value);
  const mode = stringValue(stage['mode']) ?? 'single';
  const branches = stage['branches'];
  if (mode === 'consensus') {
    return `consensus${typeof branches === 'number' && Number.isInteger(branches) ? branches : 2}`;
  }
  return mode;
}

function tagFromCellId(cellId: PipelineCoverageCellId): PipelineCoverageTag {
  return String(cellId).slice(String(cellId).lastIndexOf('::') + 2) as PipelineCoverageTag;
}

function profileSignatureFromTag(tag: PipelineCoverageTag): string | undefined {
  const match = /^profile:[^:]+:signature:(.+)$/.exec(tag);
  return match?.[1];
}

function profileRoutingSignatures(runProfiles: readonly RunProfileCoverageInput[]): string[] {
  const signatures = new Set<string>();
  for (const profile of runProfiles) {
    if (profile.status !== undefined && profile.status !== 'active') continue;
    signatures.add(routingSignatureForRunProfile(profile));
  }
  return [...signatures].sort(compareStrings);
}
