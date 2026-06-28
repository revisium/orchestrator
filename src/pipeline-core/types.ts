/**
 * pipeline-core/types.ts — the pure, framework-free data model for the pipeline state machine.
 *
 * Spec: docs/specs/pipeline-state-machine-v1.spec.md (§1 nodes, §3 transitions+guards, §4 fork/join,
 * §6 failure model, §7 scoped counters, §8 verdicts, §10 Decision + RunState).
 *
 * ZERO imports from NestJS / DBOS / Revisium / runners / any I/O. Everything here is plain data.
 */

/**
 * CORE verdicts are carried by `specVersion`. The engine acts on these STRUCTURALLY
 * (catch / onFailure / terminal / timeout) — they NEVER appear in a branch guard.
 */
export const CORE_VERDICTS = ['succeeded', 'failed', 'errored', 'timed_out'] as const;
export type CoreVerdict = (typeof CORE_VERDICTS)[number];

/** Terminal run statuses a `terminal` node may carry, and the `complete` Decision reports. */
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'blocked'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

// A DOMAIN verdict label (declared per-template in `verdicts.domain`; opaque to the engine) and
// any label that may legally appear in a `verdict.*` guard value (a domain label only) are
// both plain strings — the field/param names below carry the domain meaning.

export type Condition =
  | { op: 'verdict.eq'; value: string }
  | { op: 'verdict.in'; value: string[] }
  | { op: 'counter.lt'; scope: string; value: number }
  | { op: 'counter.gte'; scope: string; value: number }
  | { op: 'all'; of: Condition[] }
  | { op: 'any'; of: Condition[] }
  | { op: 'not'; cond: Condition };

/** Every `Condition` op tag — used by validation to reject anything outside the v1 grammar. */
export const CONDITION_OPS = [
  'verdict.eq',
  'verdict.in',
  'counter.lt',
  'counter.gte',
  'all',
  'any',
  'not',
] as const;

/** A guarded branch: route to `goto` when `when` holds. */
export type GuardedBranch = { when: Condition; goto: string };
/** The mandatory trailing fallback of a `branches` list. */
export type DefaultBranch = { default: string };
/** A `branches` entry is either a guard or the trailing default. */
export type Branch = GuardedBranch | DefaultBranch;

export function isDefaultBranch(b: Branch): b is DefaultBranch {
  return 'default' in b;
}
export function isGuardedBranch(b: Branch): b is GuardedBranch {
  return 'when' in b;
}

/** `catch` entry — engine-emitted failure routing only (matched on a reserved `revo.*` code). */
export type CatchEntry = { onError: RevoErrorCode; goto: string };

export type FailurePolicy = 'abort' | 'route' | 'escalate';
export const FAILURE_POLICIES = ['abort', 'route', 'escalate'] as const;

/** Optional gate SLA: absent ⇒ wait indefinitely. */
export type GateTimeout = { after: string; goto: string };

// Node ids, scope ids, role/script capability handles and result-schema handles are all plain
// strings; the field and parameter names below carry their domain meaning. (A roleRef/scriptRef is an
// opaque capability handle the adapter resolves — the engine holds no role-ids; a resultSchema is
// validated at the ADAPTER boundary, never in the core.)

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

/** Common envelope on every node. `id` is permanent — never reused/repurposed. */
export type NodeEnvelope = { id: string; displayName?: string };

// Dataflow — declarative step-output produce/consume (content channel, distinct from routing).
// The CORE only validates these statically; the adapter persists/hydrates at runtime.

/** Names this node's single output artifact (v1: one named output per node). */
export type ProducesDecl = { name: string };

/** A declarative reference to an earlier node's output, hydrated into the consumer's prompt. */
export type ConsumesRef = {
  node: string; //                                      producing node id (any earlier node, not just predecessor)
  as: string; //                                        key in the hydrated "## Inputs" section
  iteration?: 'latest' | 'all' | number; //             default 'latest' (max ordinal); 'all' = history; N = that ordinal
  optional?: boolean; //                                default false → a missing required input is fail-loud
  staleOk?: boolean; //                                 ack a loop-freshness risk (suppresses CONSUMES_STALE_RISK)
};

/** Fields shared by the two effect-running kinds (`agent`/`script`). */
export type EffectNodeFields = {
  next: string;
  catch?: CatchEntry[];
  resultSchema?: string;
  onFailure?: FailurePolicy; //                         default 'abort'
  escalateTo?: string; //                               required when onFailure === 'escalate'
  incrementCounters?: string[]; //                      loop-entry increment trigger
  produces?: ProducesDecl; //                           names this node's output artifact
  consumes?: ConsumesRef[]; //                          earlier-node outputs hydrated into this node
};

/** `agent` — run a generic ROLE capability → `invokeRole`. */
export type AgentNode = NodeEnvelope & { kind: 'agent'; roleRef: string } & EffectNodeFields;
/** `script` — run a built-in system SCRIPT (integrator, pollers) → `invokeScript`. */
export type ScriptNode = NodeEnvelope & { kind: 'script'; scriptRef: string } & EffectNodeFields;

/**
 * `humanGate` data refs. Informational — they enrich the gate's inbox row with the
 * artifact being gated and the upstream verdict so an approver decides without digging the agent log.
 * Routing is unchanged (the gate still routes purely on `gateVerdict`). Generic (node ids, no role ids).
 */
export type GateArtifactRef = {
  node: string; //                                       producing node id whose output is the gated artifact
  as?: string; //                                        display label in the gate row (default: the producer's output name)
  iteration?: 'latest' | 'all' | number; //             default 'latest'
};
export type GateVerdictRef = {
  node: string; //                                       node whose output is the reviewer verdict (absent ⇒ the routing verdict)
  iteration?: 'latest' | 'all' | number; //             default 'latest'
};

/** `humanGate` — suspend until an external verdict → `awaitGate`. */
export type HumanGateNode = NodeEnvelope & {
  kind: 'humanGate';
  reason: string;
  outcomes: string[]; //                                 must be ⊆ verdicts.domain
  branches: Branch[];
  timeout?: GateTimeout; //                              absent ⇒ wait indefinitely
  incrementCounters?: string[];
  gatedArtifact?: GateArtifactRef; //                    artifact surfaced inline on the gate inbox row
  verdictFrom?: GateVerdictRef; //                       reviewer verdict surfaced inline (default: routing verdict)
};

/** `choice` — pure conditional routing, no effect. */
export type ChoiceNode = NodeEnvelope & {
  kind: 'choice';
  branches: Branch[];
  incrementCounters?: string[];
};

/** A declared fork branch: a self-contained sub-graph entered at `entry`. */
export type ParallelBranch = { id: string; entry: string };
/** `parallel` — fork into N named branches → `fork`. */
export type ParallelNode = NodeEnvelope & {
  kind: 'parallel';
  branches: ParallelBranch[];
  join: string; //                                       the matching join
};

export type JoinMode = { kind: 'all' } | { kind: 'any' } | { kind: 'quorum'; count: number };
export const JOIN_MODE_KINDS = ['all', 'any', 'quorum'] as const;
/** Per-field reducer for fields written by >1 branch. `lastWrite` rejected (non-deterministic). */
export type MergeReducer = 'overwrite' | 'appendByBranchOrder';
export const MERGE_REDUCERS = ['overwrite', 'appendByBranchOrder'] as const;

/** `join` — converge branches with a mode. The interpreter aggregates RECORDED arrivals. */
export type JoinNode = NodeEnvelope & {
  kind: 'join';
  joinMode: JoinMode;
  merge?: Record<string, MergeReducer>;
  next: string;
};

/** `wait` — timed auto-resume → `startTimer`. Rare; v1 gate SLAs use `humanGate.timeout` instead. */
export type WaitNode = NodeEnvelope & { kind: 'wait'; duration: string; next: string };

/** `terminal` — end the run → `complete{status}`. No exit. */
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
  specVersion: string; //                                carries the CORE verdict vocabulary
  pipelineId: string;
  title?: string;
  entry: string; //                                      single entry (validated)
  verdicts: { domain: string[] };
  policy?: TemplatePolicy;
  scopes?: Record<string, Scope>;
  nodes: Record<string, Node>;
};

/** A reserved engine error code (`revo.<Code>`). Matched only by `catch`. */
export type RevoErrorCode = `revo.${string}`;
/** True for a well-formed reserved engine error code. */
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
      timeout?: GateTimeout; //                          OPTIONAL
      gatedArtifact?: GateArtifactRef; //                carried through from the humanGate node
      verdictFrom?: GateVerdictRef; //                   carried through from the humanGate node
    }
  | { type: 'fork'; nodeId: string; branches: ParallelBranch[]; joinId: string; mode: JoinMode }
  | { type: 'startTimer'; nodeId: string; duration: string }
  | { type: 'complete'; status: TerminalStatus };

/** Opaque input handed to a role/script effect. The core forwards data; it never inspects it. */
export type DecisionInput = Record<string, unknown>;

/** Run lifecycle status mirrored on RunState. */
export type RunStatus = 'running' | 'awaiting_gate' | 'succeeded' | 'failed' | 'blocked';

/**
 * The recorded result of the last effect, fed back into `step()` as the new `lastResult`.
 * `verdict` carries the node's DOMAIN verdict (read by `verdict.*` guards).
 * `outcome` carries a CORE verdict the engine routes STRUCTURALLY (catch / onFailure / timeout).
 *  - `succeeded` ⇒ proceed via `next`.
 *  - `failed`/`errored` ⇒ failure precedence; `errorCode` is the matched `revo.*` code.
 *  - `timed_out` ⇒ (gate) the recorded timeout firing → route via `humanGate.timeout.goto`.
 * `joinArrivals` carries the durably-recorded branch arrivals consumed by a `join` — the core
 *  never sees the live race; the adapter feeds in the canonical recorded order + cancelled set.
 */
export type LastResult = {
  outcome?: CoreVerdict;
  verdict?: string;
  errorCode?: RevoErrorCode;
  joinArrivals?: JoinArrival[];
};

/** One durably-recorded branch arrival at a join. `seq` is the monotonic recorded sequence. */
export type JoinArrival = { branchId: string; seq: number; verdict?: string };

/**
 * The live execution cursor. The core READS it and RETURNS the next one; the adapter persists
 * it. `activeNodeIds` is a set (fork makes it multi-valued). `scopedCounters` maps a scope id to
 * its current count. All values are plain/serializable — no clocks, no handles.
 */
export type RunState = {
  activeNodeIds: ReadonlySet<string>;
  scopedCounters: Readonly<Record<string, number>>;
  status: RunStatus;
  lastResult?: LastResult;
};

export type DiagnosticSeverity = 'error' | 'warning';

/**
 * A single validation finding. `code` is a stable machine code (tested against); `nodeId`/`scope`/
 * `path` localize it; `message` is human-readable.
 */
export type Diagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  nodeId?: string;
  scope?: string;
  path?: string;
};

/** Stable diagnostic codes — one per validation rule (+ sub-codes), referenced by tests and the adapter. */
export const DIAGNOSTIC_CODES = [
  // 1 single entry
  'ENTRY_MISSING',
  'ENTRY_UNRESOLVED',
  // 2 references resolve
  'REF_UNRESOLVED',
  // 3 terminals / non-terminals
  'TERMINAL_BAD_STATUS',
  'TERMINAL_HAS_EXIT',
  'NONTERMINAL_NO_EXIT',
  // 4 total routing
  'ROUTING_NO_DEFAULT',
  'ROUTING_GUARD_AFTER_DEFAULT',
  'ROUTING_MULTIPLE_DEFAULT',
  // 5 reachability
  'UNREACHABLE_NODE',
  // 6 loop-cap presence
  'LOOP_UNBOUNDED',
  // 7 counter-scope well-formedness
  'SCOPE_UNDECLARED',
  'SCOPE_PARENT_UNRESOLVED',
  'SCOPE_CYCLE',
  'SCOPE_NOT_STRICT_ANCESTOR',
  'SCOPE_SPANS_PARALLEL',
  // 8 parallel/join well-formedness
  'PARALLEL_JOIN_UNRESOLVED',
  'PARALLEL_JOIN_KIND',
  'JOIN_MULTIPLE_PARALLELS',
  'BRANCH_MEMBERSHIP',
  'BRANCH_CROSS_GOTO',
  'JOIN_UNREACHABLE_BRANCH',
  'QUORUM_K_GT_N',
  'MERGE_MISSING',
  'MERGE_LASTWRITE_REJECTED',
  // 9 verdict-vocabulary closure
  'VERDICT_UNDECLARED',
  'VERDICT_CORE_IN_GUARD',
  'VERDICT_DOMAIN_SHADOWS_CORE',
  'VERDICT_DECLARED_UNUSED',
  'GATE_OUTCOME_NOT_SUBSET',
  // 10 conflict-matrix
  'CONFLICT_SAME_ACTOR',
  'CONFLICT_REF_INVALID',
  // 11 id/namespace hygiene
  'ID_DUPLICATE',
  'ID_BAD_PATTERN',
  'REVO_CODE_COLLIDES_VERDICT',
  // 12 capability-ref shape
  'CAPABILITY_REF_SHAPE',
  // 6 failure policy well-formedness (validated structurally alongside refs)
  'FAILURE_ROUTE_NO_CATCH',
  'FAILURE_ESCALATE_NO_TARGET',
  'CATCH_BAD_CODE',
  // grammar / shape sanity (feeds rules 2/4/9 — a malformed Condition can't be evaluated)
  'CONDITION_BAD_OP',
  'CONDITION_BAD_SHAPE',
  // 14 dataflow (produces/consumes)
  'CONSUMES_NODE_UNRESOLVED', //                          consumes.node is not a node id
  'CONSUMES_PRODUCER_MISSING', //                         referenced node declares no produces / cannot produce
  'CONSUMES_NOT_DOMINATED', //                            producer does not dominate the consumer (error req / warn opt)
  'CONSUMES_STALE_RISK', //                               loop re-enterable without the producer + latest, no staleOk (warning)
  'CONSUMES_CROSS_PARALLEL_UNSAFE', //                    producer/consumer in unsafely-related parallel branches
  'CONSUMES_AS_DUP', //                                   two refs on one node share the same `as` key
  'PRODUCES_NAME_DUP', //                                 two nodes share a produces.name (warning — grammar keys by node)
  'GATE_REF_UNRESOLVED', //                               humanGate gatedArtifact/verdictFrom references an unknown node (D3)
  'GATE_ARTIFACT_NO_PRODUCES', //                         humanGate gatedArtifact node declares no produces → no artifact (D3)
  // 13 diff classifier
  'DIFF_UNCLASSIFIED',
  'DIFF_NODE_DELETED',
  'DIFF_NODE_KIND_CHANGED',
  'DIFF_NODE_TOPOLOGY_CHANGED',
  'DIFF_ID_REUSED_INCOMPATIBLE',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
