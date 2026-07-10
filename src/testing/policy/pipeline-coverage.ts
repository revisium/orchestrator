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

export type PipelineCoverageOwnership = Readonly<{
  owner: Exclude<PipelineCoverageOwner, 'dsl' | 'waiver'>;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  primaryTags: readonly PipelineCoverageTag[];
  diagnosticCode?: DefaultPlaybookPolicyDiagnosticCode;
}>;

export type PipelineCoverageWaiver = Readonly<{
  id: string;
  reason: string;
  ownerSurface: string;
  tags?: readonly PipelineCoverageTag[];
  expiry?: Readonly<{
    stage?: 'stage-2' | 'stage-3' | 'later';
    condition?: string;
  }>;
}>;

export type PipelineCoverageDiagnosticCode =
  | 'PIPELINE_COVERAGE_UNDEFINED_TAG'
  | 'PIPELINE_COVERAGE_UNOWNED_TAG'
  | 'PIPELINE_COVERAGE_DUPLICATE_OWNER'
  | 'PIPELINE_COVERAGE_OWNED_AND_WAIVED'
  | 'PIPELINE_COVERAGE_INCOMPLETE_WAIVER'
  | 'PIPELINE_COVERAGE_EXPIRED_WAIVER'
  | 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL';

export type PipelineCoverageDiagnostic = {
  code: PipelineCoverageDiagnosticCode;
  message: string;
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
  materialized: Readonly<{ pipelineId: string; profileId: string }>;
}>;

type PipelineDslCoverageScenarioWithId<Id extends string> = PipelineDslCoverageScenario & {
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
): PipelineCoverageOwnership {
  return {
    owner: 'static-policy',
    ownerSurface: DEFAULT_PLAYBOOK_POLICY_TEST,
    diagnosticCode,
    tags,
    primaryTags,
  };
}

function unit(
  ownerSurface: string,
  tags: readonly PipelineCoverageTag[],
  primaryTags: readonly PipelineCoverageTag[],
): PipelineCoverageOwnership {
  return { owner: 'unit', ownerSurface, tags, primaryTags };
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

const PIPELINE_COVERAGE_OWNERSHIP: readonly PipelineCoverageOwnership[] = [
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
  unit('src/control-plane/run-profiles.test.ts', [
    ...SINGLE_REVIEW_PROFILE_TAGS,
    ...CONSENSUS_PROFILE_TAGS,
    ...LOCAL_CHANGE_PROFILE_TAGS,
    ...ANALYSIS_ONLY_PROFILE_TAGS,
  ], [
    profileSignature('claude-standard', 'single-review'),
    profileSignature('claude-primary-codex-review-consensus', 'dual-consensus-review'),
    profileSignature('local-change-claude-standard', 'developer-single'),
    profileSignature('analysis-only-claude-standard', 'analyst-single'),
  ]),
  unit('src/pipeline-core/interpret.test.ts', [
    nodeOutcome('recoveryRouter', 'fix'),
  ], [
    nodeOutcome('recoveryRouter', 'fix'),
  ]),
] as const;

const PIPELINE_COVERAGE_WAIVERS: readonly PipelineCoverageWaiver[] = [] as const;

export const PIPELINE_COVERAGE_REGISTRY: PipelineCoverageRegistry = definePipelineCoverageRegistry({
  scenarios: PIPELINE_DSL_COVERAGE_SCENARIOS,
  ownership: PIPELINE_COVERAGE_OWNERSHIP,
  waivers: PIPELINE_COVERAGE_WAIVERS,
});

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

export function expectedCoverageTags(
  pipelines: readonly PipelineCatalogCoverageInput[],
  runProfiles: readonly RunProfileCoverageInput[],
): PipelineCoverageTag[] {
  return [...derivePipelineCoverageCatalog(pipelines, runProfiles).tags];
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
  const sortedMaterialized = materialized.sort((left, right) =>
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

export function definePipelineCoverageRegistry(input: PipelineCoverageRegistry): PipelineCoverageRegistry {
  const registry: PipelineCoverageRegistry = Object.freeze({
    scenarios: Object.freeze(input.scenarios.map((scenario) => Object.freeze({
      id: scenario.id,
      ownerSurface: scenario.ownerSurface,
      tags: Object.freeze([...scenario.tags]),
      primaryTags: Object.freeze([...scenario.primaryTags]),
      materialized: Object.freeze({
        pipelineId: scenario.materialized.pipelineId,
        profileId: scenario.materialized.profileId,
      }),
    }))),
    ownership: Object.freeze(input.ownership.map((ownership) => Object.freeze({
      owner: ownership.owner,
      ownerSurface: ownership.ownerSurface,
      tags: Object.freeze([...ownership.tags]),
      primaryTags: Object.freeze([...ownership.primaryTags]),
      ...(ownership.diagnosticCode === undefined ? {} : { diagnosticCode: ownership.diagnosticCode }),
    }))),
    waivers: Object.freeze(input.waivers.map((waiver) => Object.freeze({
      id: waiver.id,
      reason: waiver.reason,
      ownerSurface: waiver.ownerSurface,
      tags: waiver.tags === undefined ? undefined : Object.freeze([...waiver.tags]),
      expiry: waiver.expiry === undefined ? undefined : Object.freeze({
        ...(waiver.expiry.stage === undefined ? {} : { stage: waiver.expiry.stage }),
        ...(waiver.expiry.condition === undefined ? {} : { condition: waiver.expiry.condition }),
      }),
    }))),
  });
  const duplicate = [...primaryClaims(registry).entries()].find(([, claims]) => claims.length > 1);
  if (duplicate) {
    const [tag, claims] = duplicate;
    throw new Error(`multiple primary owners for ${tag}: ${claims.join(', ')}`);
  }
  validatePrimaryTagsBelongToDeclarations(registry);
  return registry;
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

function primaryClaims(registry: PipelineCoverageRegistry): Map<PipelineCoverageTag, string[]> {
  const claims = new Map<PipelineCoverageTag, string[]>();
  const add = (tag: PipelineCoverageTag, owner: string) => {
    const owners = claims.get(tag) ?? [];
    owners.push(owner);
    claims.set(tag, owners);
  };
  for (const scenario of registry.scenarios) {
    for (const tag of scenario.primaryTags) add(tag, `scenario:${scenario.id}`);
  }
  for (const ownership of registry.ownership) {
    for (const tag of ownership.primaryTags) add(tag, `${ownership.owner}:${ownership.ownerSurface}`);
  }
  return claims;
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
    const selectedMaterialized = catalog.materialized.find((identity) =>
      identity.pipelineId === scenario.materialized.pipelineId &&
      identity.profileId === scenario.materialized.profileId);
    if (!selectedMaterialized) {
      throw new Error(
        `pipeline coverage scenario ${scenario.id} references unknown materialized identity ` +
        `${scenario.materialized.pipelineId}/${scenario.materialized.profileId}`,
      );
    }
    const selectedKey = materializedCoverageKey(selectedMaterialized);
    attachmentLookup.set(scenarioId, Object.freeze({
      kind: 'registered-dsl',
      scenarioId,
      ownerSurface: scenario.ownerSurface,
      tags: Object.freeze([...scenario.tags]),
      primaryTags: Object.freeze([...scenario.primaryTags]),
      catalogIdentity: catalog.catalogIdentity,
      materialized: Object.freeze({ ...selectedMaterialized }),
      cellIds: Object.freeze(catalog.cells
        .filter((cell) =>
          materializedCoverageKey(cell.materialized) === selectedKey && scenario.tags.includes(cell.tag))
        .map((cell) => cell.id)),
      primaryCellIds: Object.freeze(catalog.cells
        .filter((cell) =>
          materializedCoverageKey(cell.materialized) === selectedKey && scenario.primaryTags.includes(cell.tag))
        .map((cell) => cell.id)),
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
  currentStage?: 'stage-2' | 'stage-3' | 'later';
}): PipelineCoverageDiagnostic[] {
  const registry = input.registry ?? PIPELINE_COVERAGE_REGISTRY;
  const definedTags = new Set(expectedCoverageTags(input.pipelines, input.runProfiles));
  const ownedTags = new Set<PipelineCoverageTag>();
  const diagnostics: PipelineCoverageDiagnostic[] = [];

  addOwnershipAlgebraDiagnostics(diagnostics, registry, input.currentStage ?? 'stage-2');
  addScenarioDiagnostics(diagnostics, definedTags, ownedTags, registry.scenarios);
  addOwnershipDiagnostics(diagnostics, definedTags, ownedTags, registry.ownership);
  addWaiverDiagnostics(diagnostics, definedTags, ownedTags, registry.waivers, input.currentStage ?? 'stage-2');
  addUnownedTagDiagnostics(diagnostics, definedTags, ownedTags);
  addProfileRoutingSignatureDiagnostics(
    diagnostics,
    input.runProfiles,
    registry,
    input.currentStage ?? 'stage-2',
  );

  return diagnostics;
}

function addScenarioDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  ownedTags: Set<PipelineCoverageTag>,
  scenarios: readonly PipelineDslCoverageScenario[],
): void {
  for (const scenario of scenarios) {
    addDefinedTagDiagnostics(diagnostics, definedTags, scenario.tags, {
      scenarioId: scenario.id,
      ownerSurface: scenario.ownerSurface,
    });
    for (const tag of scenario.primaryTags) {
      if (!scenario.tags.includes(tag)) {
        diagnostics.push({
          code: 'PIPELINE_COVERAGE_UNDEFINED_TAG',
          message: `primary coverage tag ${tag} is not declared by scenario ${scenario.id}`,
          tag,
          scenarioId: scenario.id,
          ownerSurface: scenario.ownerSurface,
        });
      }
    }
    addOwnedTags(ownedTags, scenario.primaryTags);
  }
}

function addOwnershipDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  ownedTags: Set<PipelineCoverageTag>,
  ownership: readonly PipelineCoverageOwnership[],
): void {
  for (const owner of ownership) {
    addDefinedTagDiagnostics(diagnostics, definedTags, owner.tags, {
      ownerSurface: owner.ownerSurface,
    });
    for (const tag of owner.primaryTags) {
      if (!owner.tags.includes(tag)) {
        diagnostics.push({
          code: 'PIPELINE_COVERAGE_UNDEFINED_TAG',
          message: `primary coverage tag ${tag} is not declared by ${owner.owner}:${owner.ownerSurface}`,
          tag,
          ownerSurface: owner.ownerSurface,
        });
      }
    }
    addOwnedTags(ownedTags, owner.primaryTags);
  }
}

function addWaiverDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  ownedTags: Set<PipelineCoverageTag>,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: 'stage-2' | 'stage-3' | 'later',
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
    addDefinedTagDiagnostics(diagnostics, definedTags, waiver.tags ?? [], {
      waiverId: waiver.id,
      ownerSurface: waiver.ownerSurface,
    });
    if (complete && !expired) addOwnedTags(ownedTags, waiver.tags ?? []);
  }
}

function addOwnershipAlgebraDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  registry: PipelineCoverageRegistry,
  currentStage: 'stage-2' | 'stage-3' | 'later',
): void {
  const ownerClaims = primaryClaims(registry);
  const waiverClaims = new Map<PipelineCoverageTag, string[]>();
  for (const waiver of registry.waivers) {
    if (!isCompleteCoverageWaiver(waiver) || isExpiredCoverageWaiver(waiver, currentStage)) continue;
    for (const tag of waiver.tags ?? []) {
      const claims = waiverClaims.get(tag) ?? [];
      claims.push(waiver.id);
      waiverClaims.set(tag, claims);
    }
  }

  for (const [tag, claims] of ownerClaims) {
    if (claims.length > 1) {
      diagnostics.push({
        code: 'PIPELINE_COVERAGE_DUPLICATE_OWNER',
        message: `coverage tag ${tag} has multiple primary owners: ${claims.join(', ')}`,
        tag,
      });
    }
    if (waiverClaims.has(tag)) {
      diagnostics.push({
        code: 'PIPELINE_COVERAGE_OWNED_AND_WAIVED',
        message: `coverage tag ${tag} is both owned and waived`,
        tag,
      });
    }
  }
  for (const [tag, claims] of waiverClaims) {
    if (claims.length <= 1) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_DUPLICATE_OWNER',
      message: `coverage tag ${tag} has multiple complete waivers: ${claims.join(', ')}`,
      tag,
    });
  }
}

function addUnownedTagDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  ownedTags: ReadonlySet<PipelineCoverageTag>,
): void {
  for (const tag of definedTags) {
    if (ownedTags.has(tag)) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_UNOWNED_TAG',
      message: `coverage tag ${tag} has no owner`,
      tag,
    });
  }
}

function addProfileRoutingSignatureDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  runProfiles: readonly RunProfileCoverageInput[],
  registry: PipelineCoverageRegistry,
  currentStage: 'stage-2' | 'stage-3' | 'later',
): void {
  for (const signature of profileRoutingSignatures(runProfiles)) {
    if (isProfileRoutingSignatureCovered(signature, registry, currentStage)) continue;
    diagnostics.push({
      code: 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL',
      message: `profile routing signature ${signature} has no DSL scenario owner or waiver`,
    });
  }
}

function addDefinedTagDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  tags: readonly PipelineCoverageTag[],
  context: { scenarioId?: string; ownerSurface?: string; waiverId?: string },
): void {
  for (const tag of tags) addDefinedTagDiagnostic(diagnostics, definedTags, tag, context);
}

function addOwnedTags(
  ownedTags: Set<PipelineCoverageTag>,
  tags: readonly PipelineCoverageTag[],
): void {
  for (const tag of tags) ownedTags.add(tag);
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
  registry: PipelineCoverageRegistry,
  currentStage: 'stage-2' | 'stage-3' | 'later',
): boolean {
  return hasDslScenarioForSignature(signature, registry.scenarios) ||
    hasWaiverForProfileSignature(signature, registry.waivers, currentStage);
}

function hasDslScenarioForSignature(
  signature: string,
  scenarios: readonly PipelineDslCoverageScenario[],
): boolean {
  return scenarios.some((scenario) =>
    scenario.primaryTags.some((tag) => profileSignatureFromTag(tag) === signature),
  );
}

function hasWaiverForProfileSignature(
  signature: string,
  waivers: readonly PipelineCoverageWaiver[],
  currentStage: 'stage-2' | 'stage-3' | 'later',
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
    (waiver.tags?.length ?? 0) > 0 &&
    (expiryStage !== undefined || expiryCondition.length > 0);
}

function isExpiredCoverageWaiver(
  waiver: PipelineCoverageWaiver,
  currentStage: 'stage-2' | 'stage-3' | 'later',
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

function addDefinedTagDiagnostic(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  tag: PipelineCoverageTag,
  context: { scenarioId?: string; ownerSurface?: string; waiverId?: string },
): void {
  if (definedTags.has(tag)) return;
  diagnostics.push({
    code: 'PIPELINE_COVERAGE_UNDEFINED_TAG',
    message: `coverage tag ${tag} is not defined by the bundled default catalog`,
    tag,
    ...context,
  });
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
