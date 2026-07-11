export type NonDslOwnerLayer = 'pipeline-dsl' | 'focused';

type NonDslCase<
  CaseId extends string,
  OwnerLayer extends NonDslOwnerLayer,
  OwnerSurface extends string,
  RetainedBehavior extends string,
> = Readonly<{
  kind: 'non-dsl';
  caseId: CaseId;
  ownerLayer: OwnerLayer;
  ownerSurface: OwnerSurface;
  retainedBehavior: RetainedBehavior;
}>;

type NonDslCaseDeclarations = Readonly<Record<string, string>>;

type DeclaredNonDslCases<
  OwnerLayer extends NonDslOwnerLayer,
  OwnerSurface extends string,
  Declarations extends NonDslCaseDeclarations,
> = readonly {
  [CaseId in keyof Declarations & string]: NonDslCase<
    CaseId,
    OwnerLayer,
    OwnerSurface,
    Declarations[CaseId] & string
  >;
}[keyof Declarations & string][];

function nonDslCases<
  const OwnerLayer extends NonDslOwnerLayer,
  const OwnerSurface extends string,
  const Declarations extends NonDslCaseDeclarations,
>(
  ownerLayer: OwnerLayer,
  ownerSurface: OwnerSurface,
  declarations: Declarations,
): DeclaredNonDslCases<OwnerLayer, OwnerSurface, Declarations> {
  const attachments = Object.entries(declarations).map(([caseId, retainedBehavior]) => Object.freeze({
    kind: 'non-dsl' as const,
    caseId,
    ownerLayer,
    ownerSurface,
    retainedBehavior,
  }));
  return Object.freeze(attachments) as DeclaredNonDslCases<OwnerLayer, OwnerSurface, Declarations>;
}

export const nonDslCaseManifest = Object.freeze([
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/agent-failures.e2e.test.ts', {
    C1: 'blocking review reworks and completes',
    C2: 'review iteration cap blocks',
    C3: 'developer failure reaches retry gate',
    C4: 'invalid agent result fails terminally',
  }),
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/data-driven.e2e.test.ts', {
    L1: 'data-driven plan and merge route completes',
    L4: 'produced plan hydrates developer context',
    L3: 'data-driven review cap reaches stuck gate',
  }),
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/extensibility.e2e.test.ts', {
    K1: 'declared post-integrator role completes',
    K2: 'declared post-integrator blocker reworks',
    K4: 'unknown-id declared role completes',
  }),
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/gates.e2e.test.ts', {
    B3: 'plan rejection blocks before development',
    B4: 'merge recheck re-presents merge gate',
    B10: 'pending plan decision exposes risk',
    B13: 'plan gate carries artifact and verdict',
    B12: 'parked run cancellation reaches cancelled terminal',
  }),
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/integrator-routing.e2e.test.ts', {
    D11: 'D11: nothing to integrate',
    D9: 'D9: integration recovery',
    D10: 'D10: integration recovery',
    D20: 'D20: confirm merge recovery route',
    D2: 'D2: reuse existing PR',
    D14: 'D14: GitHub failure recovery',
    D14b: 'D14b: PR ready failure recovery',
    D7: 'D7: pinned GitHub identity failure',
    D13: 'D13: push rejection',
    D15: 'D15: integrator lesson redaction',
    D19: 'D19: GitHub error redaction',
    D35: 'D35: merge conflict recovery',
    D30: 'D30: CI rework',
    D31: 'D31: review feedback fix',
    D32: 'D32: review feedback wontfix',
    D33: 'D33: review feedback question',
  }),
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/parallel-consensus.e2e.test.ts', {
    N1: 'both reviewer branches approve before join',
    N2: 'one reviewer rejection blocks consensus',
    N3: 'both reviewer rejections reach join before block',
    N4: 'approved and clean satisfy consensus',
  }),
  ...nonDslCases('pipeline-dsl', 'src/e2e/pipeline/runner-retry-gate.e2e.test.ts', {
    'RG234-A': 'transient developer failure retries in the same run and worktree',
    'RG234-B': 'transient developer failure give-up remains blocked',
    'RG234-C': 'provider overload reaches the manual retry gate',
  }),
  ...nonDslCases('focused', 'src/task-control-plane/task-control-plane-api.service.test.ts', {
    B5: 'duplicate gate resolution exposes previous status and reuses the first stored answer',
    B6: 'conflicting gate replay preserves first-decision-wins signaling',
    B7: 'question answering rejects approval gate rows',
    B9: 'unknown inbox gate operations preserve ROW_NOT_FOUND',
    I1: 'explicit pipeline selection exposes required roles and normalized gates',
    I2: 'omitted pipeline selection fails closed',
    I3: 'required roles receive ordered runner and model bindings',
    I4: 'public params remain inert and cannot select a runner',
    I5: 'inline profiles override binding axes with profile provenance',
    I6: 'unknown route resources fail closed with application errors',
    I7: 'create and simulation use the same route-decision projection',
    I8: 'profile binding provenance is retained per binding axis',
    I9: 'unknown role runner bindings fail before start',
    I9b: 'unknown node runner bindings fail before start',
    I10: 'permission mode is validated against the selected runner',
    I10b: 'GitHub account remains a script-node launch binding',
    I11: 'stored profiles materialize and stamp pinned provenance',
    H4: 'route-looking public params remain inert data',
  }),
  ...nonDslCases('focused', 'src/mcp/mcp-facade.service.test.ts', {
    H8: 'capability and registered-tool names stay aligned',
    H9: 'catalog tools delegate and preserve public projections',
    H9b: 'stored run profiles are listed through the public adapter',
  }),
  ...nonDslCases('focused', 'src/task-control-plane/task-control-plane-api.service.test.ts', {
    H9c: 'stored profile simulation returns materialized provenance',
    H9d: 'inline GitHub account binding reaches launch configuration',
  }),
  ...nonDslCases('focused', 'src/mcp/mcp-facade.service.test.ts', {
    H12: 'create response includes monitoring guidance by default',
    H12b: 'create response honors monitoring guidance opt-out',
    H12c: 'start response includes monitoring guidance',
  }),
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
  if (attachment?.ownerLayer !== 'pipeline-dsl') {
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
