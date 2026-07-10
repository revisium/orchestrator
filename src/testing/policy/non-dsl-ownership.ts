export type NonDslOwnerLayer = 'pipeline-dsl' | 'focused' | 'static-policy';

function nonDslCase<const CaseId extends string, const OwnerLayer extends NonDslOwnerLayer>(
  caseId: CaseId,
  ownerLayer: OwnerLayer,
  ownerSurface: string,
  retainedBehavior: string,
) {
  return Object.freeze({
    kind: 'non-dsl' as const,
    caseId,
    ownerLayer,
    ownerSurface,
    retainedBehavior,
  });
}

export const nonDslCaseManifest = Object.freeze([
  nonDslCase('C1', 'pipeline-dsl', 'src/e2e/pipeline/agent-failures.e2e.test.ts',
    'blocking review reworks and completes'),
  nonDslCase('C2', 'pipeline-dsl', 'src/e2e/pipeline/agent-failures.e2e.test.ts',
    'review iteration cap blocks'),
  nonDslCase('C3', 'pipeline-dsl', 'src/e2e/pipeline/agent-failures.e2e.test.ts',
    'developer failure reaches retry gate'),
  nonDslCase('C4', 'pipeline-dsl', 'src/e2e/pipeline/agent-failures.e2e.test.ts',
    'invalid agent result fails terminally'),
  nonDslCase('L1', 'pipeline-dsl', 'src/e2e/pipeline/data-driven.e2e.test.ts',
    'data-driven plan and merge route completes'),
  nonDslCase('L4', 'pipeline-dsl', 'src/e2e/pipeline/data-driven.e2e.test.ts',
    'produced plan hydrates developer context'),
  nonDslCase('L3', 'pipeline-dsl', 'src/e2e/pipeline/data-driven.e2e.test.ts',
    'data-driven review cap reaches stuck gate'),
  nonDslCase('K1', 'pipeline-dsl', 'src/e2e/pipeline/extensibility.e2e.test.ts',
    'declared post-integrator role completes'),
  nonDslCase('K2', 'pipeline-dsl', 'src/e2e/pipeline/extensibility.e2e.test.ts',
    'declared post-integrator blocker reworks'),
  nonDslCase('K4', 'pipeline-dsl', 'src/e2e/pipeline/extensibility.e2e.test.ts',
    'unknown-id declared role completes'),
  nonDslCase('B3', 'pipeline-dsl', 'src/e2e/pipeline/gates.e2e.test.ts',
    'plan rejection blocks before development'),
  nonDslCase('B4', 'pipeline-dsl', 'src/e2e/pipeline/gates.e2e.test.ts',
    'merge recheck re-presents merge gate'),
  nonDslCase('B10', 'pipeline-dsl', 'src/e2e/pipeline/gates.e2e.test.ts',
    'pending plan decision exposes risk'),
  nonDslCase('B13', 'pipeline-dsl', 'src/e2e/pipeline/gates.e2e.test.ts',
    'plan gate carries artifact and verdict'),
  nonDslCase('B12', 'pipeline-dsl', 'src/e2e/pipeline/gates.e2e.test.ts',
    'parked run cancellation reaches cancelled terminal'),
  nonDslCase('D11', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D11: nothing to integrate'),
  nonDslCase('D9', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D9: integration recovery'),
  nonDslCase('D10', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D10: integration recovery'),
  nonDslCase('D20', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D20: confirm merge recovery route'),
  nonDslCase('D2', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D2: reuse existing PR'),
  nonDslCase('D14', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D14: GitHub failure recovery'),
  nonDslCase('D14b', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D14b: PR ready failure recovery'),
  nonDslCase('D7', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D7: pinned GitHub identity failure'),
  nonDslCase('D13', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D13: push rejection'),
  nonDslCase('D15', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D15: integrator lesson redaction'),
  nonDslCase('D19', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D19: GitHub error redaction'),
  nonDslCase('D35', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D35: merge conflict recovery'),
  nonDslCase('D30', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D30: CI rework'),
  nonDslCase('D31', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D31: review feedback fix'),
  nonDslCase('D32', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D32: review feedback wontfix'),
  nonDslCase('D33', 'pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts',
    'D33: review feedback question'),
  nonDslCase('N1', 'pipeline-dsl', 'src/e2e/pipeline/parallel-consensus.e2e.test.ts',
    'both reviewer branches approve before join'),
  nonDslCase('N2', 'pipeline-dsl', 'src/e2e/pipeline/parallel-consensus.e2e.test.ts',
    'one reviewer rejection blocks consensus'),
  nonDslCase('N3', 'pipeline-dsl', 'src/e2e/pipeline/parallel-consensus.e2e.test.ts',
    'both reviewer rejections reach join before block'),
  nonDslCase('N4', 'pipeline-dsl', 'src/e2e/pipeline/parallel-consensus.e2e.test.ts',
    'approved and clean satisfy consensus'),
  nonDslCase('RG234-A', 'pipeline-dsl', 'src/e2e/pipeline/runner-retry-gate.e2e.test.ts',
    'transient developer failure retries in the same run and worktree'),
  nonDslCase('RG234-B', 'pipeline-dsl', 'src/e2e/pipeline/runner-retry-gate.e2e.test.ts',
    'transient developer failure give-up remains blocked'),
  nonDslCase('RG234-C', 'pipeline-dsl', 'src/e2e/pipeline/runner-retry-gate.e2e.test.ts',
    'provider overload reaches the manual retry gate'),
  nonDslCase('B5', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'duplicate gate resolution exposes previous status and reuses the first stored answer'),
  nonDslCase('B6', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'conflicting gate replay preserves first-decision-wins signaling'),
  nonDslCase('B7', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'question answering rejects approval gate rows'),
  nonDslCase('B9', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'unknown inbox gate operations preserve ROW_NOT_FOUND'),
  nonDslCase('I1', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'explicit pipeline selection exposes required roles and normalized gates'),
  nonDslCase('I2', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'omitted pipeline selection fails closed'),
  nonDslCase('I3', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'required roles receive ordered runner and model bindings'),
  nonDslCase('I4', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'public params remain inert and cannot select a runner'),
  nonDslCase('I5', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'inline profiles override binding axes with profile provenance'),
  nonDslCase('I6', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'unknown route resources fail closed with application errors'),
  nonDslCase('I7', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'create and simulation use the same route-decision projection'),
  nonDslCase('I8', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'profile binding provenance is retained per binding axis'),
  nonDslCase('I9', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'unknown role runner bindings fail before start'),
  nonDslCase('I9b', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'unknown node runner bindings fail before start'),
  nonDslCase('I10', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'permission mode is validated against the selected runner'),
  nonDslCase('I10b', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'GitHub account remains a script-node launch binding'),
  nonDslCase('I11', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'stored profiles materialize and stamp pinned provenance'),
  nonDslCase('H4', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'route-looking public params remain inert data'),
  nonDslCase('H8', 'focused', 'src/mcp/mcp-facade.service.test.ts',
    'capability and registered-tool names stay aligned'),
  nonDslCase('H9', 'focused', 'src/mcp/mcp-facade.service.test.ts',
    'catalog tools delegate and preserve public projections'),
  nonDslCase('H9b', 'focused', 'src/mcp/mcp-facade.service.test.ts',
    'stored run profiles are listed through the public adapter'),
  nonDslCase('H9c', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'stored profile simulation returns materialized provenance'),
  nonDslCase('H9d', 'focused', 'src/task-control-plane/task-control-plane-api.service.test.ts',
    'inline GitHub account binding reaches launch configuration'),
  nonDslCase('H12', 'focused', 'src/mcp/mcp-facade.service.test.ts',
    'create response includes monitoring guidance by default'),
  nonDslCase('H12b', 'focused', 'src/mcp/mcp-facade.service.test.ts',
    'create response honors monitoring guidance opt-out'),
  nonDslCase('H12c', 'focused', 'src/mcp/mcp-facade.service.test.ts',
    'start response includes monitoring guidance'),
] as const);

export type NonDslCaseAttachment = (typeof nonDslCaseManifest)[number];
export type PipelineNonDslCaseAttachment = Extract<NonDslCaseAttachment, { ownerLayer: 'pipeline-dsl' }>;
export type PipelineNonDslCaseId = PipelineNonDslCaseAttachment['caseId'];
export type FocusedCaseOwnership = Exclude<NonDslCaseAttachment, PipelineNonDslCaseAttachment>;
export type FocusedCaseId = FocusedCaseOwnership['caseId'];

const attachmentByCaseId = new Map<string, NonDslCaseAttachment>(
  nonDslCaseManifest.map((entry) => [entry.caseId, entry]),
);

function isFocusedCase(entry: NonDslCaseAttachment): entry is FocusedCaseOwnership {
  return entry.ownerLayer === 'focused';
}

export const focusedCaseOwnership = Object.freeze(nonDslCaseManifest.filter(isFocusedCase));

export function nonDslPipelineCaseAttachment(caseId: PipelineNonDslCaseId): PipelineNonDslCaseAttachment {
  const attachment = attachmentByCaseId.get(caseId);
  if (!attachment || attachment.ownerLayer !== 'pipeline-dsl') {
    throw new Error(`unknown non-DSL pipeline case attachment: ${caseId}`);
  }
  return attachment;
}

export function validateNonDslPipelineCaseAttachment(attachment: PipelineNonDslCaseAttachment): void {
  const canonical = attachmentByCaseId.get(attachment.caseId);
  if (canonical !== attachment || canonical.ownerLayer !== 'pipeline-dsl') {
    throw new Error('non-DSL pipeline attachment does not match the pinned manifest');
  }
}

export function focusedCaseTitle(
  caseIds: FocusedCaseId | readonly FocusedCaseId[],
  ownerSurface: string,
  behavior: string,
): string {
  const ids = typeof caseIds === 'string' ? [caseIds] : caseIds;
  for (const caseId of ids) {
    const ownership = attachmentByCaseId.get(caseId);
    if (!ownership || !isFocusedCase(ownership)) {
      throw new Error(`unknown focused case ownership: ${caseId}`);
    }
    if (ownership.ownerSurface !== ownerSurface) {
      throw new Error(`focused case ${caseId} belongs to ${ownership.ownerSurface}, not ${ownerSurface}`);
    }
  }
  return `${ids.join('/')}: ${behavior}`;
}
