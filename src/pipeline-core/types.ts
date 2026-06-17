/**
 * pipeline-core/types.ts — the pure, framework-free data model for plan 0015.
 *
 * Spec: docs/plans/0015-pipeline-state-machine.md (§1 nodes, §3 transitions+guards, §4 fork/join,
 * §6 failure model, §7 scoped counters, §8 verdicts, §10 Decision + RunState).
 *
 * ZERO imports from NestJS / DBOS / Revisium / runners / any I/O. Everything here is plain data.
 */

// ─────────────────────────────────────────────────────────────────────────────
// §8 Verdicts — two tiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CORE verdicts are carried by `specVersion` (§8). The engine acts on these STRUCTURALLY
 * (catch / onFailure / terminal / timeout) — they NEVER appear in a branch guard (§3/§6).
 */
export const CORE_VERDICTS = ['succeeded', 'failed', 'errored', 'timed_out'] as const;
export type CoreVerdict = (typeof CORE_VERDICTS)[number];

/** Terminal run statuses a `terminal` node may carry, and the `complete` Decision reports (§1/§10). */
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'blocked'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

// A DOMAIN verdict label (declared per-template in `verdicts.domain`; opaque to the engine, §8) and
// any label that may legally appear in a `verdict.*` guard value (a domain label only, §3/§8/§9.9) are
// both plain strings — the field/param names below carry the domain meaning.

// ─────────────────────────────────────────────────────────────────────────────
// §3 Condition — closed tagged union (NO expression strings). v1 grammar = verdict + counter only.
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// §3 Branches — ordered guards, first-true-wins, mandatory trailing default.
// ─────────────────────────────────────────────────────────────────────────────

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

/** §6 `catch` entry — engine-emitted failure routing only (matched on a reserved `revo.*` code). */
export type CatchEntry = { onError: RevoErrorCode; goto: string };

/** §6 per-node failure policy. */
export type FailurePolicy = 'abort' | 'route' | 'escalate';
export const FAILURE_POLICIES = ['abort', 'route', 'escalate'] as const;

/** §6 optional gate SLA: absent ⇒ wait indefinitely. */
export type GateTimeout = { after: string; goto: string };

// ─────────────────────────────────────────────────────────────────────────────
// §1/§3/§4 Node — the closed 8-kind discriminated union.
//
// Node ids, scope ids, role/script capability handles and result-schema handles are all plain
// strings; the field and parameter names below carry their domain meaning. (A roleRef/scriptRef is an
// opaque capability handle the adapter resolves — the engine holds no role-ids, §1; a resultSchema is
// validated at the ADAPTER boundary, never in the core, §10.)
// ─────────────────────────────────────────────────────────────────────────────

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

/** Common envelope on every node (§1). `id` is permanent — never reused/repurposed. */
export type NodeEnvelope = { id: string; displayName?: string };

// ─────────────────────────────────────────────────────────────────────────────
// 0016 §3 Dataflow — declarative step-output produce/consume (content channel, distinct from routing).
// The CORE only validates these statically (§7); the adapter persists/hydrates at runtime (0016 §5/§6).
// ─────────────────────────────────────────────────────────────────────────────

/** Names this node's single output artifact (v1: one named output per node). */
export type ProducesDecl = { name: string };

/** A declarative reference to an earlier node's output, hydrated into the consumer's prompt (0016 §3). */
export type ConsumesRef = {
  node: string; //                                      producing node id (any earlier node, not just predecessor)
  as: string; //                                        key in the hydrated "## Inputs" section
  iteration?: 'latest' | 'all' | number; //             default 'latest' (max ordinal); 'all' = history; N = that ordinal
  optional?: boolean; //                                default false → a missing required input is fail-loud (0016 §6)
  staleOk?: boolean; //                                 ack a loop-freshness risk (suppresses CONSUMES_STALE_RISK, §7)
};

/** Fields shared by the two effect-running kinds (`agent`/`script`) — §3 next/catch, §6/§7 policy. */
export type EffectNodeFields = {
  next: string;
  catch?: CatchEntry[];
  resultSchema?: string;
  onFailure?: FailurePolicy; //                         default 'abort' (§6)
  escalateTo?: string; //                               required when onFailure === 'escalate' (§6)
  incrementCounters?: string[]; //                      loop-entry increment trigger (§7)
  produces?: ProducesDecl; //                           0016 §3 — names this node's output artifact
  consumes?: ConsumesRef[]; //                          0016 §3 — earlier-node outputs hydrated into this node
};

/** `agent` — run a generic ROLE capability → `invokeRole`. */
export type AgentNode = NodeEnvelope & { kind: 'agent'; roleRef: string } & EffectNodeFields;
/** `script` — run a built-in system SCRIPT (integrator, pollers) → `invokeScript`. */
export type ScriptNode = NodeEnvelope & { kind: 'script'; scriptRef: string } & EffectNodeFields;

/** `humanGate` — suspend until an external verdict → `awaitGate`. */
export type HumanGateNode = NodeEnvelope & {
  kind: 'humanGate';
  reason: string;
  outcomes: string[]; //                                 must be ⊆ verdicts.domain (§8/§12.9)
  branches: Branch[];
  timeout?: GateTimeout; //                              §6 — absent ⇒ wait indefinitely
  incrementCounters?: string[];
};

/** `choice` — pure conditional routing, no effect. */
export type ChoiceNode = NodeEnvelope & {
  kind: 'choice';
  branches: Branch[];
  incrementCounters?: string[];
};

/** §4 a declared fork branch: a self-contained sub-graph entered at `entry`. */
export type ParallelBranch = { id: string; entry: string };
/** `parallel` — fork into N named branches → `fork`. */
export type ParallelNode = NodeEnvelope & {
  kind: 'parallel';
  branches: ParallelBranch[];
  join: string; //                                       the matching join (§4/§12.8)
};

/** §4 join mode. */
export type JoinMode = { kind: 'all' } | { kind: 'any' } | { kind: 'quorum'; count: number };
export const JOIN_MODE_KINDS = ['all', 'any', 'quorum'] as const;
/** §4 per-field reducer for fields written by >1 branch. `lastWrite` rejected (non-deterministic). */
export type MergeReducer = 'overwrite' | 'appendByBranchOrder';
export const MERGE_REDUCERS = ['overwrite', 'appendByBranchOrder'] as const;

/** `join` — converge branches with a mode. The interpreter aggregates RECORDED arrivals (§4). */
export type JoinNode = NodeEnvelope & {
  kind: 'join';
  joinMode: JoinMode;
  merge?: Record<string, MergeReducer>;
  next: string;
};

/** `wait` — timed auto-resume → `startTimer`. Rare; v1 gate SLAs use `humanGate.timeout` instead (§1). */
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

// ─────────────────────────────────────────────────────────────────────────────
// §7 Scopes — loop/counter scopes. The scope id IS the canonical counter identifier.
// ─────────────────────────────────────────────────────────────────────────────

export type Scope = { cap: number; parent: string | null };

// ─────────────────────────────────────────────────────────────────────────────
// §2 Template — one record.
// ─────────────────────────────────────────────────────────────────────────────

export type TemplatePolicy = {
  conflicts: Array<[string, string]>;
  enforcement: 'strict' | 'warn';
};

export type Template = {
  specVersion: string; //                                carries the CORE verdict vocabulary (§8)
  pipelineId: string;
  title?: string;
  entry: string; //                                      single entry (validated, §12.1)
  verdicts: { domain: string[] };
  policy?: TemplatePolicy;
  scopes?: Record<string, Scope>;
  nodes: Record<string, Node>;
};

// ─────────────────────────────────────────────────────────────────────────────
// §6 revo.* reserved error-code namespace — disjoint from verdict labels.
// ─────────────────────────────────────────────────────────────────────────────

/** A reserved engine error code (`revo.<Code>`). Matched only by `catch` (§3/§6). */
export type RevoErrorCode = `revo.${string}`;
/** True for a well-formed reserved engine error code. */
export function isRevoErrorCode(value: string): value is RevoErrorCode {
  return /^revo\.[A-Za-z][A-Za-z0-9]*$/.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 Decision — the effect the core asks the adapter to perform.
// ─────────────────────────────────────────────────────────────────────────────

export type Decision =
  | { type: 'invokeRole'; nodeId: string; roleRef: string; input: DecisionInput }
  | { type: 'invokeScript'; nodeId: string; scriptRef: string; input: DecisionInput }
  | {
      type: 'awaitGate';
      nodeId: string;
      reason: string;
      outcomes: string[];
      timeout?: GateTimeout; //                          OPTIONAL (§6/§10)
    }
  | { type: 'fork'; nodeId: string; branches: ParallelBranch[]; joinId: string; mode: JoinMode }
  | { type: 'startTimer'; nodeId: string; duration: string }
  | { type: 'complete'; status: TerminalStatus };

/** Opaque input handed to a role/script effect. The core forwards data; it never inspects it. */
export type DecisionInput = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// §8/§10 lastResult — the RECORDED result fed back into step() (no live reads).
// ─────────────────────────────────────────────────────────────────────────────

/** Run lifecycle status mirrored on RunState (§9/§10). */
export type RunStatus = 'running' | 'awaiting_gate' | 'succeeded' | 'failed' | 'blocked';

/**
 * The recorded result of the last effect, fed back into `step()` as the new `lastResult` (§10).
 * `verdict` carries the node's DOMAIN verdict (read by `verdict.*` guards, §3/§8).
 * `outcome` carries a CORE verdict the engine routes STRUCTURALLY (catch / onFailure / timeout, §6).
 *  - `succeeded` ⇒ proceed via `next`.
 *  - `failed`/`errored` ⇒ failure precedence (§6); `errorCode` is the matched `revo.*` code.
 *  - `timed_out` ⇒ (gate) the recorded timeout firing → route via `humanGate.timeout.goto`.
 * `joinArrivals` carries the durably-recorded branch arrivals consumed by a `join` (§4) — the core
 *  never sees the live race; the adapter feeds in the canonical recorded order + cancelled set.
 */
export type LastResult = {
  outcome?: CoreVerdict;
  verdict?: string;
  errorCode?: RevoErrorCode;
  joinArrivals?: JoinArrival[];
};

/** One durably-recorded branch arrival at a join (§4). `seq` is the monotonic recorded sequence. */
export type JoinArrival = { branchId: string; seq: number; verdict?: string };

// ─────────────────────────────────────────────────────────────────────────────
// §7/§9/§10 RunState — the durable cursor the core reads and returns (pure values only).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The live execution cursor (§9). The core READS it and RETURNS the next one; the adapter persists
 * it. `activeNodeIds` is a set (fork makes it multi-valued, §4). `scopedCounters` maps a scope id to
 * its current count (§7). All values are plain/serializable — no clocks, no handles.
 */
export type RunState = {
  activeNodeIds: ReadonlySet<string>;
  scopedCounters: Readonly<Record<string, number>>;
  status: RunStatus;
  lastResult?: LastResult;
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 Diagnostics — the validator output.
// ─────────────────────────────────────────────────────────────────────────────

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

/** Stable diagnostic codes — one per §12 rule (+ sub-codes), referenced by tests and the adapter. */
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
  // 14 dataflow (produces/consumes, 0016 §7)
  'CONSUMES_NODE_UNRESOLVED', //                          consumes.node is not a node id
  'CONSUMES_PRODUCER_MISSING', //                         referenced node declares no produces / cannot produce
  'CONSUMES_NOT_DOMINATED', //                            producer does not dominate the consumer (error req / warn opt)
  'CONSUMES_STALE_RISK', //                               loop re-enterable without the producer + latest, no staleOk (warning)
  'CONSUMES_CROSS_PARALLEL_UNSAFE', //                    producer/consumer in unsafely-related parallel branches
  'CONSUMES_AS_DUP', //                                   two refs on one node share the same `as` key
  'PRODUCES_NAME_DUP', //                                 two nodes share a produces.name (warning — grammar keys by node)
  // 13 diff classifier
  'DIFF_UNCLASSIFIED',
  'DIFF_NODE_DELETED',
  'DIFF_NODE_KIND_CHANGED',
  'DIFF_NODE_TOPOLOGY_CHANGED',
  'DIFF_ID_REUSED_INCOMPATIBLE',
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
