import type { DefaultPlaybookPolicyDiagnosticCode } from './default-playbook-policy.js';
import type { Branch, Condition, RevoErrorCode, Template } from '../pipeline-core/types.js';
import { isDefaultBranch, isGuardedBranch } from '../pipeline-core/types.js';

export type PipelineCoverageTag =
  | `node:${string}:outcome:${string}`
  | `node:${string}:catch:${RevoErrorCode}`
  | `node:${string}:default`
  | `profile:${string}:signature:${string}`;

export type PipelineScenarioCoverage = {
  scenarioId: PipelineCoverageScenarioId;
  tags: readonly PipelineCoverageTag[];
};

export type PipelineCoverageOwner = 'dsl' | 'static-policy' | 'unit' | 'waiver';

export type PipelineCoverageOwnership = {
  owner: Exclude<PipelineCoverageOwner, 'dsl' | 'waiver'>;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
  diagnosticCode?: DefaultPlaybookPolicyDiagnosticCode;
};

export type PipelineCoverageWaiver = {
  id: string;
  reason: string;
  ownerSurface: string;
  tags?: readonly PipelineCoverageTag[];
};

export type PipelineCoverageDiagnosticCode =
  | 'PIPELINE_COVERAGE_UNDEFINED_TAG'
  | 'PIPELINE_COVERAGE_UNOWNED_TAG'
  | 'PIPELINE_COVERAGE_INCOMPLETE_WAIVER'
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

export type PipelineCoverageRegistry = {
  scenarios: readonly PipelineDslCoverageScenario[];
  ownership: readonly PipelineCoverageOwnership[];
  waivers: readonly PipelineCoverageWaiver[];
};

type PipelineDslCoverageScenario = {
  id: string;
  ownerSurface: string;
  tags: readonly PipelineCoverageTag[];
};

type PipelineDslCoverageScenarioWithId<Id extends string> = PipelineDslCoverageScenario & {
  readonly id: Id;
};

const DEFAULT_PLAYBOOK_POLICY_TEST = 'src/control-plane/default-playbook-policy.test.ts';
const RECOVERY_GRAPH_E2E_TEST = 'src/e2e/recovery-graph.e2e.test.ts';
const RUNNER_RETRY_GATE_E2E_TEST = 'src/e2e/runner-retry-gate.e2e.test.ts';
const SEED_DEFAULT_PLAYBOOK_E2E_TEST = 'src/e2e/seed-default-playbook.e2e.test.ts';
const TARGET_CONTRACT_E2E_TEST = 'src/e2e/target-contract-red-suite.e2e.test.ts';

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function dslScenario<const Id extends string>(
  id: Id,
  ownerSurface: string,
  tags: readonly PipelineCoverageTag[],
): PipelineDslCoverageScenarioWithId<Id> {
  return { id, ownerSurface, tags };
}

function recoveryGraphScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, RECOVERY_GRAPH_E2E_TEST, tags);
}

function runnerRetryGateScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, RUNNER_RETRY_GATE_E2E_TEST, tags);
}

function targetContractScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, TARGET_CONTRACT_E2E_TEST, tags);
}

function seedDefaultPlaybookScenario<const Id extends string>(
  id: Id,
  tags: readonly PipelineCoverageTag[],
): PipelineDslCoverageScenarioWithId<Id> {
  return dslScenario(id, SEED_DEFAULT_PLAYBOOK_E2E_TEST, tags);
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
): PipelineCoverageOwnership {
  return {
    owner: 'static-policy',
    ownerSurface: DEFAULT_PLAYBOOK_POLICY_TEST,
    diagnosticCode,
    tags,
  };
}

function unit(ownerSurface: string, tags: readonly PipelineCoverageTag[]): PipelineCoverageOwnership {
  return { owner: 'unit', ownerSurface, tags };
}

const SINGLE_REVIEW_PROFILE_TAGS = [
  profileSignature('claude-standard', 'single-review'),
  profileSignature('codex-standard', 'single-review'),
] as const;

const CONSENSUS_PROFILE_TAGS = [
  profileSignature('codex-primary-claude-review-consensus', 'dual-consensus-review'),
  profileSignature('claude-primary-codex-review-consensus', 'dual-consensus-review'),
] as const;

export const PIPELINE_DSL_COVERAGE_SCENARIOS = [
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
  ),
  recoveryGraphScenario(
    'RG-G-stale-reverify-recovery',
    [
      nodeCatch('mergeApproveReverify', 'revo.ScriptBlocked'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
  ),
  targetContractScenario(
    'TC-272-no-checks-clean',
    [
      nodeOutcome('prRouter', 'clean'),
      nodeOutcome('mergeReadinessRouter', 'clean'),
      nodeOutcome('mergeGate', 'cancel'),
    ],
  ),
  targetContractScenario(
    'TC-272-never-settling-recovery',
    [
      nodeOutcome('prRouter', 'recheck'),
      nodeDefault('prRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
  ),
  targetContractScenario(
    'TC-272-unclassifiable-recovery',
    [
      nodeDefault('recoveryRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
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
  ),
  targetContractScenario(
    'TC-274-head-moved-reopens-merge-gate',
    [
      nodeOutcome('mergeGate', 'approved'),
      nodeOutcome('mergeGate', 'cancel'),
    ],
  ),
  targetContractScenario(
    'TC-275-graphql-outage-recovery',
    [
      nodeCatch('pollPr', 'revo.ScriptFailed'),
      nodeDefault('recoveryRouter'),
      nodeOutcome('recoveryGate', 'cancel'),
    ],
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
  ),
  targetContractScenario(
    'TC-277-cleanup-dirty-preserve',
    [
      nodeOutcome('mergeGate', 'approved'),
      nodeOutcome('mergeApproveReverifyRouter', 'clean'),
    ],
  ),
  targetContractScenario(
    'TC-279-override-advisory-thread',
    [
      nodeOutcome('mergeGate', 'override_merge'),
      nodeOutcome('overrideMergeRouter', 'clean'),
    ],
  ),
  runnerRetryGateScenario(
    'RG234-D-agent-question-resume',
    [],
  ),
  seedDefaultPlaybookScenario(
    'M1-profile-single',
    [
      profileSignature('codex-standard', 'single-review'),
      nodeOutcome('planReviewRouter', 'approved'),
      nodeOutcome('planGate', 'approved'),
      nodeOutcome('codeReviewRouter', 'approved'),
      nodeOutcome('mergeGate', 'approved'),
    ],
  ),
  seedDefaultPlaybookScenario(
    'M1b-profile-consensus-rework',
    [
      profileSignature('codex-primary-claude-review-consensus', 'dual-consensus-review'),
      nodeOutcome('planReviewRouter', 'changes_requested'),
      nodeOutcome('planReviewRouter', 'approved'),
      nodeOutcome('planGate', 'approved'),
      nodeOutcome('codeReviewRouter', 'approved'),
      nodeOutcome('mergeGate', 'approved'),
    ],
  ),
] as const;

export type PipelineCoverageScenarioId = (typeof PIPELINE_DSL_COVERAGE_SCENARIOS)[number]['id'];

export const PIPELINE_COVERAGE_OWNERSHIP: readonly PipelineCoverageOwnership[] = [
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
  ]),
  staticPolicy('DEFAULT_POLICY_PR_FRESHNESS_WIRING_MISSING', [
    ...nodeOutcomes('prRouter', ['clean', 'merged', 'closed']),
    ...nodeOutcomes('mergeReadinessRouter', ['clean', 'merged', 'closed']),
  ]),
  staticPolicy('DEFAULT_POLICY_CI_CHANGES_ROUTE_MISSING', [
    nodeOutcome('prRouter', 'ci_changes'),
    nodeOutcome('mergeReadinessRouter', 'ci_changes'),
  ]),
  staticPolicy('DEFAULT_POLICY_REVIEW_CHANGES_ROUTE_MISSING', [
    nodeOutcome('prRouter', 'review_changes'),
    nodeOutcome('mergeReadinessRouter', 'review_changes'),
    ...nodeOutcomes('triageRouter', ['question', 'fix', 'wontfix']),
    ...nodeOutcomes('questionGate', ['fix', 'wontfix', 'cancel']),
    nodeDefault('questionGate'),
  ]),
  staticPolicy('DEFAULT_POLICY_APPROVE_REVERIFY_MISSING', [
    nodeOutcome('mergeGate', 'approved'),
    ...nodeOutcomes('mergeApproveReverifyRouter', ['clean', 'merged', 'closed']),
    nodeDefault('mergeApproveReverifyRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING', [
    ...nodeOutcomes('mergeGate', ['recheck', 'address_review_threads', 'return_to_development', 'cancel']),
    ...nodeOutcomes('mergeRecheckRouter', ['clean', 'merged', 'closed', 'review_changes', 'ci_changes', 'recheck']),
    nodeDefault('mergeRecheckRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_OVERRIDE_MERGE_ROUTE_MISSING', [
    nodeOutcome('mergeGate', 'override_merge'),
    ...nodeOutcomes('overrideMergeRouter', ['clean', 'merged', 'closed']),
    nodeDefault('overrideMergeRouter'),
  ]),
  staticPolicy('DEFAULT_POLICY_GATE_OUTCOMES_IMPLICIT', [
    ...nodeOutcomes('recoveryGate', ['recheck', 'cancel']),
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
  ]),
  staticPolicy('DEFAULT_POLICY_RECOVERABLE_CATCH_TERMINAL', [
    ...nodeCatches([
      'pollPr',
      'mergeReadiness',
      'mergeRecheck',
      'mergeApproveReverify',
      'overrideMerge',
      'integrator',
      'reviewIntegrator',
      'questionReviewIntegrator',
      'respondThreads',
    ]),
  ]),
  staticPolicy('DEFAULT_POLICY_CONFIRM_MERGE_FAILURE_TERMINAL', [
    ...nodeCatches(['confirmMerge', 'overrideConfirmMerge']),
  ]),
  staticPolicy('DEFAULT_POLICY_POST_MERGE_CLEANUP_MISSING', [
    ...nodeCatches(['cleanupWorktree']),
  ]),
  unit('src/control-plane/run-profiles.test.ts', [
    ...SINGLE_REVIEW_PROFILE_TAGS,
    ...CONSENSUS_PROFILE_TAGS,
  ]),
  unit('src/control-plane/seed-default-playbook.test.ts', [
    ...SINGLE_REVIEW_PROFILE_TAGS,
    ...CONSENSUS_PROFILE_TAGS,
  ]),
  unit('src/pipeline-core/interpret.test.ts', [
    nodeOutcome('recoveryRouter', 'fix'),
  ]),
] as const;

export const PIPELINE_COVERAGE_WAIVERS: readonly PipelineCoverageWaiver[] = [] as const;

export const PIPELINE_COVERAGE_REGISTRY: PipelineCoverageRegistry = {
  scenarios: PIPELINE_DSL_COVERAGE_SCENARIOS,
  ownership: PIPELINE_COVERAGE_OWNERSHIP,
  waivers: PIPELINE_COVERAGE_WAIVERS,
};

const scenarioCoverageById = new Map(
  PIPELINE_DSL_COVERAGE_SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

export function coverageForScenario(scenarioId: PipelineCoverageScenarioId): PipelineScenarioCoverage {
  const scenario = scenarioCoverageById.get(scenarioId);
  if (!scenario) throw new Error(`unknown pipeline coverage scenario: ${scenarioId}`);
  return { scenarioId, tags: [...scenario.tags] };
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
  const tags = new Set<PipelineCoverageTag>();
  for (const pipeline of pipelines) {
    const template = pipeline.execution_policy?.template_json;
    if (!template) continue;
    for (const tag of graphCoverageTagsForTemplate(template)) tags.add(tag);
  }
  for (const profile of runProfiles) {
    if (profile.status !== undefined && profile.status !== 'active') continue;
    tags.add(profileCoverageTag(profile));
  }
  return [...tags].sort(compareStrings);
}

export function validatePipelineCoverageRegistry(input: {
  pipelines: readonly PipelineCatalogCoverageInput[];
  runProfiles: readonly RunProfileCoverageInput[];
  registry?: PipelineCoverageRegistry;
}): PipelineCoverageDiagnostic[] {
  const registry = input.registry ?? PIPELINE_COVERAGE_REGISTRY;
  const definedTags = new Set(expectedCoverageTags(input.pipelines, input.runProfiles));
  const ownedTags = new Set<PipelineCoverageTag>();
  const diagnostics: PipelineCoverageDiagnostic[] = [];

  addScenarioDiagnostics(diagnostics, definedTags, ownedTags, registry.scenarios);
  addOwnershipDiagnostics(diagnostics, definedTags, ownedTags, registry.ownership);
  addWaiverDiagnostics(diagnostics, definedTags, ownedTags, registry.waivers);
  addUnownedTagDiagnostics(diagnostics, definedTags, ownedTags);
  addProfileRoutingSignatureDiagnostics(diagnostics, input.runProfiles, registry);

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
    addOwnedTags(ownedTags, scenario.tags);
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
    addOwnedTags(ownedTags, owner.tags);
  }
}

function addWaiverDiagnostics(
  diagnostics: PipelineCoverageDiagnostic[],
  definedTags: ReadonlySet<PipelineCoverageTag>,
  ownedTags: Set<PipelineCoverageTag>,
  waivers: readonly PipelineCoverageWaiver[],
): void {
  for (const waiver of waivers) {
    const complete = isCompleteCoverageWaiver(waiver);
    if (!complete) addIncompleteWaiverDiagnostic(diagnostics, waiver);
    addDefinedTagDiagnostics(diagnostics, definedTags, waiver.tags ?? [], {
      waiverId: waiver.id,
      ownerSurface: waiver.ownerSurface,
    });
    if (complete) addOwnedTags(ownedTags, waiver.tags ?? []);
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
): void {
  for (const signature of profileRoutingSignatures(runProfiles)) {
    if (isProfileRoutingSignatureCovered(signature, registry)) continue;
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
    message: `coverage waiver ${waiver.id} must include reason and ownerSurface`,
    waiverId: waiver.id,
  });
}

function isProfileRoutingSignatureCovered(
  signature: string,
  registry: PipelineCoverageRegistry,
): boolean {
  return hasDslScenarioForSignature(signature, registry.scenarios) ||
    hasWaiverForProfileSignature(signature, registry.waivers);
}

function hasDslScenarioForSignature(
  signature: string,
  scenarios: readonly PipelineDslCoverageScenario[],
): boolean {
  return scenarios.some((scenario) =>
    scenario.tags.some((tag) => profileSignatureFromTag(tag) === signature),
  );
}

function hasWaiverForProfileSignature(
  signature: string,
  waivers: readonly PipelineCoverageWaiver[],
): boolean {
  return waivers.some((waiver) =>
    isCompleteCoverageWaiver(waiver) &&
    (waiver.tags ?? []).some((tag) => profileSignatureFromTag(tag) === signature),
  );
}

function isCompleteCoverageWaiver(waiver: PipelineCoverageWaiver): boolean {
  return waiver.reason.trim().length > 0 && waiver.ownerSurface.trim().length > 0;
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
