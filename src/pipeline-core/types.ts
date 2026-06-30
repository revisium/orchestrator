








export const CORE_VERDICTS = ['succeeded', 'failed', 'errored', 'timed_out'] as const;
export type CoreVerdict = (typeof CORE_VERDICTS)[number];


export const TERMINAL_STATUSES = ['succeeded', 'failed', 'blocked'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];


export type Condition =
  | { op: 'verdict.eq'; value: string }
  | { op: 'verdict.in'; value: string[] }
  | { op: 'counter.lt'; scope: string; value: number }
  | { op: 'counter.gte'; scope: string; value: number }
  | { op: 'all'; of: Condition[] }
  | { op: 'any'; of: Condition[] }
  | { op: 'not'; cond: Condition };


export const CONDITION_OPS = [
  'verdict.eq',
  'verdict.in',
  'counter.lt',
  'counter.gte',
  'all',
  'any',
  'not',
] as const;


export type GuardedBranch = { when: Condition; goto: string };

export type DefaultBranch = { default: string };

export type Branch = GuardedBranch | DefaultBranch;

export function isDefaultBranch(b: Branch): b is DefaultBranch {
  return 'default' in b;
}
export function isGuardedBranch(b: Branch): b is GuardedBranch {
  return 'when' in b;
}


export type CatchEntry = { onError: RevoErrorCode; goto: string };

export type FailurePolicy = 'abort' | 'route' | 'escalate';
export const FAILURE_POLICIES = ['abort', 'route', 'escalate'] as const;


export type GateTimeout = { after: string; goto: string };


export const NODE_KINDS = [
  'agent',
  'script',
  'humanGate',
  'choice',
  'parallel',
  'join',
  'wait',
  'terminal',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];


export type NodeEnvelope = { id: string; displayName?: string };



export type ProducesDecl = { name: string };


export type ConsumesRef = {
  node: string;
  as: string;
  iteration?: 'latest' | 'all' | number;
  optional?: boolean;
  staleOk?: boolean;
};


export type EffectNodeFields = {
  next: string;
  catch?: CatchEntry[];
  resultSchema?: string;
  onFailure?: FailurePolicy;
  escalateTo?: string;
  incrementCounters?: string[];
  produces?: ProducesDecl;
  consumes?: ConsumesRef[];
};


export type AgentNode = NodeEnvelope & { kind: 'agent'; roleRef: string } & EffectNodeFields;

export type ScriptNode = NodeEnvelope & { kind: 'script'; scriptRef: string } & EffectNodeFields;




export type GateArtifactRef = {
  node: string;
  as?: string;
  iteration?: 'latest' | 'all' | number;
};
export type GateVerdictRef = {
  node: string;
  iteration?: 'latest' | 'all' | number;
};


export type HumanGateNode = NodeEnvelope & {
  kind: 'humanGate';
  reason: string;
  outcomes: string[];
  branches: Branch[];
  timeout?: GateTimeout;
  incrementCounters?: string[];
  gatedArtifact?: GateArtifactRef;
  verdictFrom?: GateVerdictRef;
};


export type ChoiceNode = NodeEnvelope & {
  kind: 'choice';
  branches: Branch[];
  incrementCounters?: string[];
};


export type ParallelBranch = { id: string; entry: string };

export type ParallelNode = NodeEnvelope & {
  kind: 'parallel';
  branches: ParallelBranch[];
  join: string;
};

export type JoinMode = { kind: 'all' } | { kind: 'any' } | { kind: 'quorum'; count: number };
export const JOIN_MODE_KINDS = ['all', 'any', 'quorum'] as const;

export type MergeReducer = 'overwrite' | 'appendByBranchOrder';
export const MERGE_REDUCERS = ['overwrite', 'appendByBranchOrder'] as const;

export type JoinVerdictReducer = {
  kind: 'allIn';
  pass: string[];
  passVerdict: string;
  failVerdict: string;
};
export const JOIN_VERDICT_REDUCER_KINDS = ['allIn'] as const;

export type JoinNode = NodeEnvelope & {
  kind: 'join';
  joinMode: JoinMode;
  merge?: Record<string, MergeReducer>;
  verdictReducer?: JoinVerdictReducer;
  next: string;
};


export type WaitNode = NodeEnvelope & { kind: 'wait'; duration: string; next: string };


export type TerminalNode = NodeEnvelope & { kind: 'terminal'; status: TerminalStatus };

export type Node =
  | AgentNode
  | ScriptNode
  | HumanGateNode
  | ChoiceNode
  | ParallelNode
  | JoinNode
  | WaitNode
  | TerminalNode;

export type Scope = { cap: number; parent: string | null };


export type TemplatePolicy = {
  conflicts: Array<[string, string]>;
  enforcement: 'strict' | 'warn';
};

export type Template = {
  specVersion: string;
  pipelineId: string;
  title?: string;
  entry: string;
  verdicts: { domain: string[] };
  policy?: TemplatePolicy;
  scopes?: Record<string, Scope>;
  nodes: Record<string, Node>;
};


export type RevoErrorCode = `revo.${string}`;

export function isRevoErrorCode(value: string): value is RevoErrorCode {
  return /^revo\.[A-Za-z][A-Za-z0-9]*$/.test(value);
}

export type Decision =
  | { type: 'invokeRole'; nodeId: string; roleRef: string; input: DecisionInput }
  | { type: 'invokeScript'; nodeId: string; scriptRef: string; input: DecisionInput }
  | {
      type: 'awaitGate';
      nodeId: string;
      reason: string;
      outcomes: string[];
      timeout?: GateTimeout;
      gatedArtifact?: GateArtifactRef;
      verdictFrom?: GateVerdictRef;
    }
  | { type: 'fork'; nodeId: string; branches: ParallelBranch[]; joinId: string; mode: JoinMode }
  | { type: 'startTimer'; nodeId: string; duration: string }
  | { type: 'complete'; status: TerminalStatus };


export type DecisionInput = Record<string, unknown>;


export type RunStatus = 'running' | 'awaiting_gate' | 'succeeded' | 'failed' | 'blocked';









export type LastResult = {
  outcome?: CoreVerdict;
  verdict?: string;
  errorCode?: RevoErrorCode;
  joinArrivals?: JoinArrival[];
};


export type JoinArrival = { branchId: string; seq: number; verdict?: string };




export type RunState = {
  activeNodeIds: ReadonlySet<string>;
  scopedCounters: Readonly<Record<string, number>>;
  status: RunStatus;
  lastResult?: LastResult;
};

export type DiagnosticSeverity = 'error' | 'warning';



export type Diagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  nodeId?: string;
  scope?: string;
  path?: string;
};


export const DIAGNOSTIC_CODES = [
  'ENTRY_MISSING',
  'ENTRY_UNRESOLVED',
  'REF_UNRESOLVED',
  'TERMINAL_BAD_STATUS',
  'TERMINAL_HAS_EXIT',
  'NONTERMINAL_NO_EXIT',
  'ROUTING_NO_DEFAULT',
  'ROUTING_GUARD_AFTER_DEFAULT',
  'ROUTING_MULTIPLE_DEFAULT',
  'UNREACHABLE_NODE',
  'LOOP_UNBOUNDED',
  'SCOPE_UNDECLARED',
  'SCOPE_PARENT_UNRESOLVED',
  'SCOPE_CYCLE',
  'SCOPE_NOT_STRICT_ANCESTOR',
  'SCOPE_SPANS_PARALLEL',
  'PARALLEL_JOIN_UNRESOLVED',
  'PARALLEL_JOIN_KIND',
  'JOIN_MULTIPLE_PARALLELS',
  'BRANCH_MEMBERSHIP',
  'BRANCH_CROSS_GOTO',
  'BRANCH_TERMINAL_BEFORE_JOIN',
  'JOIN_UNREACHABLE_BRANCH',
  'QUORUM_K_GT_N',
  'MERGE_MISSING',
  'MERGE_LASTWRITE_REJECTED',
  'VERDICT_UNDECLARED',
  'VERDICT_CORE_IN_GUARD',
  'VERDICT_DOMAIN_SHADOWS_CORE',
  'VERDICT_DECLARED_UNUSED',
  'VERDICT_REDUCER_BAD_KIND',
  'VERDICT_REDUCER_BAD_SHAPE',
  'GATE_OUTCOME_NOT_SUBSET',
  'CONFLICT_SAME_ACTOR',
  'CONFLICT_REF_INVALID',
  'ID_DUPLICATE',
  'ID_BAD_PATTERN',
  'REVO_CODE_COLLIDES_VERDICT',
  'CAPABILITY_REF_SHAPE',
  'FAILURE_ROUTE_NO_CATCH',
  'FAILURE_ESCALATE_NO_TARGET',
  'CATCH_BAD_CODE',
  'CONDITION_BAD_OP',
  'CONDITION_BAD_SHAPE',
  'CONSUMES_NODE_UNRESOLVED',
  'CONSUMES_PRODUCER_MISSING',
  'CONSUMES_NOT_DOMINATED',
  'CONSUMES_STALE_RISK',
  'CONSUMES_CROSS_PARALLEL_UNSAFE',
  'CONSUMES_AS_DUP',
  'PRODUCES_NAME_DUP',
  'GATE_REF_UNRESOLVED',
  'GATE_ARTIFACT_NO_PRODUCES',
  'DIFF_UNCLASSIFIED',
  'DIFF_NODE_DELETED',
  'DIFF_NODE_KIND_CHANGED',
  'DIFF_NODE_TOPOLOGY_CHANGED',
  'DIFF_ID_REUSED_INCOMPATIBLE',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
