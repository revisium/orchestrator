import type { AgentSpec } from "./agents.js";
import type { IntegratorOutcome } from "./fake-integrator.js";
import type { GhScenario } from "./gh-emulator.js";
import type { PipelineScenarioCoverage } from "../../testing/policy/pipeline-coverage.js";
import type { PipelineNonDslCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";

export type Primitive = string | number | boolean | null;
export type ReadonlyJson =
  | Primitive
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const PIPELINE_TARGET = Symbol("pipeline-target");
export type PipelineTarget = Readonly<{ readonly [PIPELINE_TARGET]: true }>;
export type ScenarioRepo = "workspace" | PipelineTarget;
export type PipelineAgentPlan = AgentSpec;
export type PipelineProfile =
  | "default-agent"
  | "default-full"
  | "fixture-agent"
  | "fixture-full"
  | "fixture-integrator";

type ControlledGiven = Readonly<{
  repo: ScenarioRepo;
  pipelineId?: string;
  github?: GhScenario;
  integrator?: DeepReadonly<IntegratorOutcome>;
  agent?: DeepReadonly<AgentSpec>;
  developerWrite?: boolean;
  cleanup?: Readonly<{
    releaseWorktreeFails?: boolean;
    dirtyWorktreeBeforeRelease?: boolean;
  }>;
}>;
type BuiltInPlaybook = Readonly<{
  playbook?: "fixture" | "default";
  playbookId?: never;
}>;
type CustomPlaybook = Readonly<{ playbook?: never; playbookId: string }>;
type InlineProfile = Readonly<{ profile?: PipelineProfile; profileId?: never }>;
type StoredProfile = Readonly<{ profile?: never; profileId: string }>;
export type NonDslPipelineGiven = ControlledGiven &
  (BuiltInPlaybook | CustomPlaybook) &
  (InlineProfile | StoredProfile);
export type RegisteredPipelineGiven = ControlledGiven &
  Readonly<{ playbook: "default"; playbookId?: never }> &
  (
    | Readonly<{
        profile?: "default-agent" | "default-full";
        profileId?: never;
      }>
    | StoredProfile
  );

export type PipelineGateNodeId =
  | "planGate"
  | "codeStuckGate"
  | "mergeGate"
  | "questionGate"
  | "recoveryGate";
export type PlanGateOutcome =
  | "approved"
  | "changes_requested"
  | "rework"
  | "cancel";
export type CodeStuckGateOutcome =
  | "approve_anyway"
  | "rework"
  | "abort"
  | "cancel";
export type MergeGateOutcome =
  | "approved"
  | "changes_requested"
  | "recheck"
  | "address_review_threads"
  | "return_to_development"
  | "cancel";
export type QuestionGateOutcome = "fix" | "wontfix" | "cancel";
export type RecoveryGateOutcome = "recheck" | "cancel";
export type GraphGateAction =
  | Readonly<{ do: "chooseGate"; node: "planGate"; outcome: PlanGateOutcome }>
  | Readonly<{
      do: "chooseGate";
      node: "codeStuckGate";
      outcome: CodeStuckGateOutcome;
    }>
  | Readonly<{ do: "chooseGate"; node: "mergeGate"; outcome: MergeGateOutcome }>
  | Readonly<{
      do: "chooseGate";
      node: "questionGate";
      outcome: QuestionGateOutcome;
      note?: string;
    }>
  | Readonly<{
      do: "chooseGate";
      node: "recoveryGate";
      outcome: RecoveryGateOutcome;
    }>;
export type MergeOverrideAction = Readonly<{
  do: "overrideMerge";
  node: "mergeGate";
  outcome: "override_merge";
  note: string;
  audit: Readonly<{
    threadIds: readonly string[];
    actor: string;
    reason: string;
    risk: string;
    verificationResponsibility: string;
    headSha: string;
  }>;
}>;
export type PipelineAction =
  | GraphGateAction
  | MergeOverrideAction
  | Readonly<{
      do: "retryAgent";
      node: "developer";
      outcome: "retry";
      reconcile: "keep";
    }>
  | Readonly<{
      do: "retryAgent";
      node: "developer";
      outcome: "give_up";
      reconcile?: never;
    }>
  | Readonly<{ do: "answerQuestion"; node: "analyst"; answer: ReadonlyJson }>
  | Readonly<{ do: "rejectGate"; node: "planGate" }>
  | Readonly<{ do: "cancelRun"; at: "planGate" }>;
export type GateVisit<
  Node extends PipelineGateNodeId | "developer" | "analyst" =
    | PipelineGateNodeId
    | "developer"
    | "analyst",
> = Readonly<{ node: Node; occurrence: number }>;
type SummaryVisit = GateVisit<
  "mergeGate" | "recoveryGate" | "developer" | "analyst"
>;
export type PipelineTerminal = "completed" | "cancelled" | "blocked" | "failed";
export type PipelineEngine = "data-driven";
export type PipelineSideEffect =
  | "create_pull_request"
  | "merge_pull_request"
  | "list_open_pull_requests"
  | "list_all_pull_requests";
export type PipelineEventType =
  | "agent_question_opened"
  | "agent_question_resolved"
  | "cleanup_failed"
  | "integrate_succeeded"
  | "merge_confirmed"
  | "merge_overridden"
  | "pipeline_blocked"
  | "pipeline_fork"
  | "pr_polled"
  | "run_completed"
  | "run_failed"
  | "run_recovery_created"
  | "runner_retry_exhausted"
  | "step_failed"
  | "step_succeeded"
  | "threads_responded"
  | "worktree_released";
type PlainEvent = Exclude<
  PipelineEventType,
  | "cleanup_failed"
  | "merge_overridden"
  | "pipeline_blocked"
  | "pr_polled"
  | "step_failed"
  | "step_succeeded"
>;
export type PipelineEventMatch =
  | Readonly<{ type: PlainEvent }>
  | Readonly<{
      type: "pr_polled";
      where?: Readonly<{
        verdict:
          | "clean"
          | "ci_changes"
          | "recheck"
          | "merged"
          | "closed"
          | "review_changes";
      }>;
    }>
  | Readonly<{
      type: "pipeline_blocked";
      where?: Readonly<{ reason?: string; nodeId?: string }>;
    }>
  | Readonly<{ type: "step_failed"; where?: Readonly<{ error: string }> }>
  | Readonly<{
      type: "step_succeeded";
      where?: Readonly<{ stepKey: string; attemptNo: number }>;
    }>
  | Readonly<{
      type: "cleanup_failed";
      where?: Readonly<{ reason: "dirty"; released: false }>;
    }>
  | Readonly<{
      type: "merge_overridden";
      where?: Readonly<{
        actor: string;
        note: string;
        reason: string;
        risk: string;
        verificationResponsibility: string;
        headSha: string;
        prNumber: number;
      }>;
    }>;
export type PipelineExpectation =
  | Readonly<{ check: "terminal"; equals: PipelineTerminal }>
  | Readonly<{ check: "engine"; equals: PipelineEngine }>
  | Readonly<{ check: "event"; event: PipelineEventMatch }>
  | Readonly<{
      check: "eventPath";
      events: readonly [PipelineEventMatch, ...PipelineEventMatch[]];
    }>
  | Readonly<{ check: "forbiddenEvent"; type: PipelineEventType }>
  | Readonly<{
      check: "blockedDecision";
      reason: string;
      lessonContains: readonly [string, ...string[]];
    }>
  | Readonly<{
      check: "failureReason";
      contains: readonly [string, ...string[]];
    }>
  | Readonly<{
      check: "sideEffect";
      effect: PipelineSideEffect;
      presence: "required" | "forbidden";
    }>
  | Readonly<{ check: "roleCalled"; role: string }>
  | Readonly<{ check: "nodeCalled"; node: string }>
  | Readonly<{
      check: "roleCallCount";
      role: string;
      count: Readonly<{ exact: number } | { minimum: number }>;
    }>
  | Readonly<{ check: "roleWorktree"; role: string; equals: "run-worktree" }>
  | Readonly<{
      check: "roleRetryContext";
      role: string;
      callIndex: number;
      equals: Readonly<{
        kind: "agent_question";
        nodeId: string;
        answer: ReadonlyJson;
        lesson: string;
        resolvedBy: string;
      }>;
      distinctInboxFromCallIndex?: number;
    }>
  | Readonly<{ check: "roleContext"; role: string; contains: string }>
  | Readonly<{
      check: "roleAfterEvent";
      role: string;
      event: PipelineEventType;
    }>
  | Readonly<{
      check: "reviewerConsensus";
      nodeIds: readonly string[];
      verdicts: readonly string[];
      attemptVerdicts?: readonly string[];
      processArtifacts?: "required";
    }>
  | Readonly<{ check: "persistedEvents"; excludes: string }>
  | Readonly<{ check: "reviewReply"; contains: string }>
  | Readonly<{ check: "gateSummary"; at: SummaryVisit; contains: string }>
  | Readonly<{
      check: "gateOptions";
      at: GateVisit<"planGate">;
      equals: readonly PlanGateOutcome[];
    }>
  | Readonly<{
      check: "pendingGateRisk";
      at: GateVisit<"planGate">;
      equals: Readonly<{ topic: "plan"; kind: "approval" }>;
    }>
  | Readonly<{
      check: "planGateArtifact";
      at: GateVisit<"planGate">;
      source: Readonly<{ nodeId: "analyst"; name: "plan" }>;
      content: "payload-or-preview";
      reviewerVerdict: "present";
    }>
  | Readonly<{
      check: "gateArtifactHead";
      at: GateVisit<"mergeGate">;
      equals: string;
    }>;
export type PipelineThen = readonly PipelineExpectation[];
export type PipelineCase = Readonly<{
  when: readonly PipelineAction[];
  then: PipelineThen;
}> &
  (
    | Readonly<{
        coverage: PipelineScenarioCoverage;
        given: RegisteredPipelineGiven;
      }>
    | Readonly<{
        coverage: PipelineNonDslCaseAttachment;
        given: NonDslPipelineGiven;
      }>
  );

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
export function gateVisit<const Node extends GateVisit["node"]>(
  node: Node,
  occurrence = 1,
): GateVisit<Node> {
  if (!Number.isInteger(occurrence) || occurrence < 1)
    throw new RangeError("gate occurrence must be a positive integer");
  return freeze({ node, occurrence });
}
export function chooseGate(
  node: "planGate",
  outcome: PlanGateOutcome,
): Extract<GraphGateAction, { node: "planGate" }>;
export function chooseGate(
  node: "codeStuckGate",
  outcome: CodeStuckGateOutcome,
): Extract<GraphGateAction, { node: "codeStuckGate" }>;
export function chooseGate(
  node: "mergeGate",
  outcome: MergeGateOutcome,
): Extract<GraphGateAction, { node: "mergeGate" }>;
export function chooseGate(
  node: "questionGate",
  outcome: QuestionGateOutcome,
  note?: string,
): Extract<GraphGateAction, { node: "questionGate" }>;
export function chooseGate(
  node: "recoveryGate",
  outcome: RecoveryGateOutcome,
): Extract<GraphGateAction, { node: "recoveryGate" }>;
export function chooseGate(
  node: PipelineGateNodeId,
  outcome: string,
  note?: string,
): GraphGateAction {
  return freeze({
    do: "chooseGate",
    node,
    outcome,
    ...(note === undefined ? {} : { note }),
  }) as GraphGateAction;
}
export function overrideMerge(
  note: string,
  audit: MergeOverrideAction["audit"],
): MergeOverrideAction {
  return freeze({
    do: "overrideMerge",
    node: "mergeGate",
    outcome: "override_merge",
    note,
    audit: freeze({ ...audit, threadIds: freeze([...audit.threadIds]) }),
  });
}
export function retryAgent(
  node: "developer",
  outcome: "retry",
  reconcile: "keep",
): Extract<PipelineAction, { do: "retryAgent"; outcome: "retry" }>;
export function retryAgent(
  node: "developer",
  outcome: "give_up",
): Extract<PipelineAction, { do: "retryAgent"; outcome: "give_up" }>;
export function retryAgent(
  node: "developer",
  outcome: "retry" | "give_up",
  reconcile?: "keep",
): PipelineAction {
  return freeze({
    do: "retryAgent",
    node,
    outcome,
    ...(reconcile === undefined ? {} : { reconcile }),
  }) as PipelineAction;
}
export function answerQuestion(
  node: "analyst",
  answer: ReadonlyJson,
): Extract<PipelineAction, { do: "answerQuestion" }> {
  return freeze({ do: "answerQuestion", node, answer });
}
export function rejectGate(
  node: "planGate",
): Extract<PipelineAction, { do: "rejectGate" }> {
  return freeze({ do: "rejectGate", node });
}
export function cancelRunAt(
  node: "planGate",
): Extract<PipelineAction, { do: "cancelRun" }> {
  return freeze({ do: "cancelRun", at: node });
}
export function expectTerminal(
  equals: PipelineTerminal,
): Extract<PipelineExpectation, { check: "terminal" }> {
  return freeze({ check: "terminal", equals });
}
export function expectEvent(
  event: PipelineEventMatch,
): Extract<PipelineExpectation, { check: "event" }> {
  return freeze({ check: "event", event });
}
export function expectEventPath(
  events: readonly [PipelineEventMatch, ...PipelineEventMatch[]],
): Extract<PipelineExpectation, { check: "eventPath" }> {
  return freeze({ check: "eventPath", events: freeze([...events]) });
}
export function forbidEvent(
  type: PipelineEventType,
): Extract<PipelineExpectation, { check: "forbiddenEvent" }> {
  return freeze({ check: "forbiddenEvent", type });
}
export function expectSideEffect(
  effect: PipelineSideEffect,
): Extract<PipelineExpectation, { check: "sideEffect" }> {
  return freeze({ check: "sideEffect", effect, presence: "required" });
}
export function forbidSideEffect(
  effect: PipelineSideEffect,
): Extract<PipelineExpectation, { check: "sideEffect" }> {
  return freeze({ check: "sideEffect", effect, presence: "forbidden" });
}
