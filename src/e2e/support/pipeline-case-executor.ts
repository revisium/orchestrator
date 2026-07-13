import assert from "node:assert/strict";
import type { TaskControlPlaneApiService } from "../../task-control-plane/task-control-plane-api.service.js";
import type { AgentSpec } from "./agents.js";
import type { IntegratorOutcome } from "./fake-integrator.js";
import type { GhScenario } from "./gh-emulator.js";
import { caseGhCallBoundary } from "./gh-call-log.js";
import type { TargetRepo } from "./git-target-repo.js";
import type { HostFixture } from "./harness.js";
import { DEFAULT_PLAYBOOK_ID, PLAYBOOK_ID } from "./scenarios.js";
import { hashTemplate } from "../../pipeline-core/materialize.js";
import { templateFromExecutionPolicy } from "../../pipeline/data-driven-template.js";
import { executionPlanFromRouteDecision, type RouteDecision } from "../../pipeline/route-contract.js";
import { waitForGate, waitState } from "./drive.js";
import { assertCaseExpectations } from "./pipeline-case-evidence.js";
import {
  stubDefaultAgentProfile,
  stubFixtureAgentProfile,
  stubFixturePipelineProfile,
  type E2eRunProfile,
} from "./run-profiles.js";
import {
  materializedCoverageIdentity,
  validatePipelineCaseAttachment,
  type PipelineCaseAttachment,
} from "../../testing/policy/pipeline-coverage.js";
import type {
  PipelineAction,
  PipelineCase,
  PipelineExpectation,
  PipelineProfile,
} from "./pipeline-case.js";

type GateTopic = "plan" | "merge" | "question" | "retry";

export type StartedPipelineCase = {
  runId: string;
  taskId: string;
  engine?: string;
  ghCallBoundary: number;
  title: string;
  coverage: PipelineCaseAttachment;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: string;
  cleanup?: {
    releaseWorktreeFails?: boolean;
    dirtyWorktreeBeforeRelease?: boolean;
  };
};
function repoPath(
  repo: PipelineCase["given"]["repo"],
  targets: WeakMap<object, TargetRepo>,
): string {
  if (repo === undefined)
    throw new Error("pipelineScenario requires an explicit repo");
  if (repo === "workspace") return process.cwd();
  const target = targets.get(repo);
  if (!target)
    throw new Error("pipeline target must be created by its owning context");
  return target.worktree;
}

function runProfile(profile: PipelineProfile, pipelineId: string): E2eRunProfile {
  if (profile === "default-agent") return stubDefaultAgentProfile(pipelineId);
  if (profile === "default-full") return stubDefaultAgentProfile(pipelineId);
  if (profile === "fixture-full") return stubFixtureAgentProfile(pipelineId);
  if (profile === "fixture-integrator") return stubFixturePipelineProfile(pipelineId);
  return stubFixtureAgentProfile(pipelineId);
}

function assertObservedGate(
  gate: {
    topic: string;
    options: readonly string[];
    context: Record<string, unknown>;
  },
  expected: { node: string; topic: GateTopic; outcomes: readonly string[] },
): void {
  assert.equal(
    gate.topic,
    expected.topic,
    `expected ${expected.topic} gate, got ${gate.topic}`,
  );
  assert.deepEqual(
    gate.options,
    expected.outcomes,
    `unexpected ${expected.topic} gate options`,
  );
  const summary = gate.context["summary"];
  assert.ok(
    summary !== null && typeof summary === "object" && !Array.isArray(summary),
    `${gate.topic} gate must include a summary`,
  );
  const summaryRecord = summary as Record<string, unknown>;
  assert.equal(
    summaryRecord["nodeId"],
    expected.node,
    `expected ${gate.topic} gate node ${expected.node}`,
  );
  assert.deepEqual(
    summaryRecord["outcomes"],
    expected.outcomes,
    `unexpected ${expected.topic} gate outcomes`,
  );
}

async function waitForQuestion(
  api: TaskControlPlaneApiService,
  runId: string,
): Promise<{ inboxId: string; context: Record<string, unknown> }> {
  const state = await waitState(api, runId);
  assert.equal(
    state.state,
    "question",
    `expected question, got ${state.state}`,
  );
  const inbox = state.inbox;
  assert.ok(inbox, "question must include the inbox item to resolve");
  const context = inbox.context;
  assert.ok(
    context !== null && typeof context === "object" && !Array.isArray(context),
  );
  return decodeAgentQuestion({ id: inbox.id, context });
}

function persistedPayload(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type AgentQuestionSnapshot = Readonly<{
  inboxId: string;
  context: Record<string, unknown>;
}>;

function decodeAgentQuestion(inbox: {
  id: string;
  context: unknown;
}): AgentQuestionSnapshot {
  const context = persistedPayload(inbox.context);
  const summary = context && persistedPayload(context["summary"]);
  assert.equal(context?.["topic"], "question");
  assert.equal(summary?.["kind"], "agent_question");
  assert.equal(summary?.["nodeId"], "analyst");
  for (const field of ["taskId", "step", "runner", "lesson", "attemptId"])
    assert.equal(
      typeof summary?.[field],
      "string",
      `question summary must include ${field}`,
    );
  assert.ok(context);
  return { inboxId: inbox.id, context };
}

type PinnedGate = Readonly<{
  node: string;
  topic: GateTopic;
  outcomes: readonly string[];
}>;
type PinnedCatalog = Readonly<{
  gates: ReadonlyMap<string, PinnedGate>;
  agents: ReadonlyMap<string, string>;
  template: import("../../pipeline-core/types.js").Template;
}>;
type PreparedCase = Readonly<{
  casePlan: PipelineCase;
  repo: string;
  title: string;
  playbookId: string;
  pipelineId: string;
  profileId?: string;
  profile?: E2eRunProfile;
}>;
function topicFromPinnedGateReason(reason: string): GateTopic {
  if (reason.includes("merge")) return "merge";
  if (reason.includes("question")) return "question";
  return "plan";
}

function selectorProfile(given: PipelineCase["given"], pipelineId: string): {
  profileId?: string;
  profile?: E2eRunProfile;
} {
  if ("profileId" in given) return { profileId: given.profileId };
  return {
    profile: runProfile(
      given.profile ??
        (given.playbook === "default" ? "default-agent" : "fixture-agent"),
      pipelineId,
    ),
  };
}

function validateCasePreflight(
  casePlan: PipelineCase,
  targets: WeakMap<object, TargetRepo>,
): PreparedCase {
  const given = casePlan.given;
  const playbook =
    "playbookId" in given
      ? given.playbookId
      : given.playbook === "default"
        ? DEFAULT_PLAYBOOK_ID
        : PLAYBOOK_ID;
  const pipelineId = given.pipelineId ?? "feature-development";
  if (
    !playbook ||
    ("playbookId" in given &&
      given.playbookId !== undefined &&
      given.playbookId.length === 0)
  ) {
    throw new Error("playbook id must not be empty");
  }
  if (
    "profileId" in given &&
    given.profileId !== undefined &&
    given.profileId.length === 0
  ) {
    throw new Error("profile id must not be empty");
  }
  if (casePlan.coverage.kind === "registered-dsl") {
    if (playbook !== DEFAULT_PLAYBOOK_ID) {
      throw new Error(
        "registered pipeline attachment does not match the selected materialized identity",
      );
    }
    const profileId =
      "profileId" in given && given.profileId !== undefined
        ? given.profileId
        : "base";
    validatePipelineCaseAttachment(
      casePlan.coverage,
      materializedCoverageIdentity(pipelineId, profileId),
    );
  } else {
    validatePipelineCaseAttachment(casePlan.coverage);
  }
  return {
    casePlan,
    repo: repoPath(given.repo, targets),
    title:
      casePlan.coverage.kind === "registered-dsl"
        ? casePlan.coverage.scenarioId
        : casePlan.coverage.caseId,
    playbookId: playbook,
    pipelineId,
    ...selectorProfile(given, pipelineId),
  };
}

function indexPinnedGates(
  template: import("../../pipeline-core/types.js").Template,
): PinnedCatalog {
  const gates = new Map<string, PinnedGate>();
  const agents = new Map<string, string>();
  for (const node of Object.values(template.nodes)) {
    if (node.kind === "humanGate") {
      gates.set(
        node.id,
        Object.freeze({
          node: node.id,
          topic: topicFromPinnedGateReason(node.reason),
          outcomes: Object.freeze([...node.outcomes]),
        }),
      );
    }
    if (node.kind === "agent") agents.set(node.id, node.roleRef);
  }
  return Object.freeze({ template, gates, agents });
}
function validateReturnedRoute(
  route: RouteDecision,
  prepared: PreparedCase,
): PinnedCatalog {
  const plan = executionPlanFromRouteDecision(route);
  const projection = route.projection;
  assert.equal(
    projection.playbookId,
    prepared.playbookId,
    "returned route playbook mismatch",
  );
  assert.equal(
    projection.pipelineId,
    prepared.pipelineId,
    "returned route pipeline mismatch",
  );
  assert.ok(
    projection.materializedTemplateHash,
    "returned route materialized template hash is required",
  );
  const template = plan.pipeline.executableGraph;
  assert.ok(
    template && typeof template === "object",
    "returned route materialized template is required",
  );
  const executionTemplate = templateFromExecutionPolicy(plan.pipeline.executionPolicy);
  assert.ok(
    executionTemplate,
    "returned route execution policy must contain a materialized template",
  );
  assert.deepEqual(
    executionTemplate,
    template,
    "returned route template differs from execution policy template",
  );
  assert.equal(
    hashTemplate(template as import("../../pipeline-core/types.js").Template),
    projection.materializedTemplateHash,
    "returned route template hash mismatch",
  );
  if (prepared.profileId !== undefined) {
    assert.equal(
      projection.profileSource,
      "stored",
      "returned route profile provenance mismatch",
    );
    assert.equal(
      projection.profileId,
      prepared.profileId,
      "returned route profile id mismatch",
    );
  } else {
    assert.equal(
      projection.profileSource,
      "inline",
      "returned route profile provenance mismatch",
    );
    assert.equal(
      projection.profileId,
      undefined,
      "inline route must not return a profile id",
    );
  }
  if (prepared.casePlan.coverage.kind === "registered-dsl")
    assert.equal(
      projection.materializedTemplateHash,
      prepared.casePlan.coverage.materialized.materializedTemplateHash,
      "returned route hash does not match canonical coverage",
    );
  return indexPinnedGates(
    template as import("../../pipeline-core/types.js").Template,
  );
}
async function createCase(h: HostFixture, prepared: PreparedCase) {
  const created = await h.api.createRun({
    repo: prepared.repo,
    title: prepared.title,
    description: prepared.title,
    scope: prepared.title,
    playbookId: prepared.playbookId,
    pipelineId: prepared.pipelineId,
    ...(prepared.profileId
      ? { profileId: prepared.profileId }
      : { profile: prepared.profile }),
    start: false,
  });
  assert.ok("route" in created, "createRun must return the pinned route");
  return { created, catalog: validateReturnedRoute(created.route, prepared) };
}
function gateForAction(
  action: PipelineAction,
  catalog: PinnedCatalog,
): PinnedGate {
  const node = action.do === "cancelRun" ? action.at : action.node;
  const gate = catalog.gates.get(node);
  assert.ok(gate, `action node ${node} is not a pinned human gate`);
  if (action.do === "chooseGate" || action.do === "overrideMerge")
    assert.ok(
      gate.outcomes.includes(action.outcome),
      `outcome ${action.outcome} is not pinned for ${node}`,
    );
  return gate;
}

function decodeRetryGate(gate: Awaited<ReturnType<typeof waitForGate>>): void {
  assert.equal(gate.topic, "retry");
  const summary = persistedPayload(gate.context.summary);
  assert.equal(summary?.["kind"], "transient_retry");
  assert.equal(summary?.["nodeId"], "developer");
  assert.deepEqual(gate.options, ["retry", "give_up"]);
  assert.deepEqual(summary?.["outcomes"], ["retry", "give_up"]);
}
function validateActions(
  actions: readonly PipelineAction[],
  catalog: PinnedCatalog,
): void {
  for (const action of actions) {
    if (action.do === "answerQuestion" || action.do === "retryAgent") {
      const role = action.do === "answerQuestion" ? "analyst" : "developer";
      assert.equal(
        catalog.agents.get(action.node),
        `role:${role}`,
        `${action.do} node ${action.node} is not the pinned ${role} agent`,
      );
      continue;
    }
    gateForAction(action, catalog);
  }
}
export type GateVisitRecord = Readonly<{
  visit: { node: string; occurrence: number };
  gate: {
    inboxId: string;
    topic: string;
    options: readonly string[];
    context: Record<string, unknown>;
  };
  risk?: { topic: string; kind: string };
}>;
function visitKey(visit: { node: string; occurrence: number }): string {
  return `${visit.node}#${visit.occurrence}`;
}
function nextOccurrence(
  occurrences: Map<string, number>,
  node: string,
): number {
  const occurrence = (occurrences.get(node) ?? 0) + 1;
  occurrences.set(node, occurrence);
  return occurrence;
}
type GraphAction = Extract<
  PipelineAction,
  { do: "chooseGate" | "overrideMerge" | "rejectGate" | "cancelRun" }
>;
async function captureGraphGate(
  h: HostFixture,
  prepared: PreparedCase,
  catalog: PinnedCatalog,
  runCase: StartedPipelineCase,
  action: GraphAction,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<Awaited<ReturnType<typeof waitForGate>>> {
  const pinned = gateForAction(action, catalog);
  const gate = await waitForGate(h.api, runCase.runId);
  assertObservedGate(gate, pinned);
  const riskExpectation = prepared.casePlan.then.find(
    (
      item,
    ): item is Extract<PipelineExpectation, { check: "pendingGateRisk" }> =>
      item.check === "pendingGateRisk" &&
      item.at.node === node &&
      item.at.occurrence === occurrence,
  );
  const rawRisk = riskExpectation
    ? await h.api.summarizeGateRisk(gate.inboxId)
    : undefined;
  const risk =
    rawRisk?.topic && rawRisk.kind
      ? { topic: rawRisk.topic, kind: rawRisk.kind }
      : undefined;
  if (riskExpectation) {
    const pending = await h.api.getPendingDecisions(runCase.runId);
    assert.ok(pending.some((item) => item.id === gate.inboxId));
    assert.equal(risk?.topic, riskExpectation.equals.topic);
    assert.equal(risk?.kind, riskExpectation.equals.kind);
  }
  visits.set(visitKey({ node, occurrence }), {
    visit: { node, occurrence },
    gate,
    ...(risk ? { risk } : {}),
  });
  return gate;
}
async function answerAgentQuestion(
  h: HostFixture,
  runCase: StartedPipelineCase,
  action: Extract<PipelineAction, { do: "answerQuestion" }>,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<void> {
  const question = await waitForQuestion(h.api, runCase.runId);
  visits.set(visitKey({ node, occurrence }), {
    visit: { node, occurrence },
    gate: {
      inboxId: question.inboxId,
      topic: "question",
      options: [],
      context: question.context,
    },
  });
  await h.api.answerQuestion({
    inboxId: question.inboxId,
    answer: action.answer,
    resolvedBy: "e2e",
  });
}
async function decideRetry(
  h: HostFixture,
  runCase: StartedPipelineCase,
  action: Extract<PipelineAction, { do: "retryAgent" }>,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<void> {
  const gate = await waitForGate(h.api, runCase.runId, "retry");
  decodeRetryGate(gate);
  visits.set(visitKey({ node, occurrence }), {
    visit: { node, occurrence },
    gate,
  });
  await h.api.resolveGate({
    inboxId: gate.inboxId,
    outcome: action.outcome,
    resolvedBy: "e2e",
    ...(action.outcome === "retry" ? { reconcile: "keep" as const } : {}),
  });
}
async function chooseGraphGate(
  h: HostFixture,
  prepared: PreparedCase,
  catalog: PinnedCatalog,
  runCase: StartedPipelineCase,
  action: Extract<PipelineAction, { do: "chooseGate" }>,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<void> {
  const gate = await captureGraphGate(
    h,
    prepared,
    catalog,
    runCase,
    action,
    node,
    occurrence,
    visits,
  );
  await h.api.resolveGate({
    inboxId: gate.inboxId,
    outcome: action.outcome,
    resolvedBy: "e2e",
    ...(!("note" in action) || action.note === undefined
      ? {}
      : { note: action.note }),
  });
}
async function overrideMergeGate(
  h: HostFixture,
  prepared: PreparedCase,
  catalog: PinnedCatalog,
  runCase: StartedPipelineCase,
  action: Extract<PipelineAction, { do: "overrideMerge" }>,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<void> {
  const gate = await captureGraphGate(
    h,
    prepared,
    catalog,
    runCase,
    action,
    node,
    occurrence,
    visits,
  );
  if (runCase.gh === "force-advisory-thread")
    h.casePlans.showAdvisoryThread(runCase.taskId);
  await h.api.resolveGate({
    inboxId: gate.inboxId,
    outcome: action.outcome,
    resolvedBy: "e2e",
    note: action.note,
    mergeOverrideAudit: {
      ...action.audit,
      threadIds: [...action.audit.threadIds],
    },
  });
}
async function rejectGraphGate(
  h: HostFixture,
  prepared: PreparedCase,
  catalog: PinnedCatalog,
  runCase: StartedPipelineCase,
  action: Extract<PipelineAction, { do: "rejectGate" }>,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<void> {
  const gate = await captureGraphGate(
    h,
    prepared,
    catalog,
    runCase,
    action,
    node,
    occurrence,
    visits,
  );
  await h.api.rejectGate({ inboxId: gate.inboxId, resolvedBy: "e2e" });
}
async function cancelRunAtGate(
  h: HostFixture,
  prepared: PreparedCase,
  catalog: PinnedCatalog,
  runCase: StartedPipelineCase,
  action: Extract<PipelineAction, { do: "cancelRun" }>,
  node: string,
  occurrence: number,
  visits: Map<string, GateVisitRecord>,
): Promise<void> {
  const gate = await captureGraphGate(
    h,
    prepared,
    catalog,
    runCase,
    action,
    node,
    occurrence,
    visits,
  );
  await h.api.cancelRun(runCase.runId);
  await h.api
    .rejectGate({ inboxId: gate.inboxId, resolvedBy: "e2e" })
    .catch(() => undefined);
}
async function executeActions(
  h: HostFixture,
  prepared: PreparedCase,
  catalog: PinnedCatalog,
  visits: Map<string, GateVisitRecord>,
  runCase: StartedPipelineCase,
): Promise<void> {
  const occurrences = new Map<string, number>();
  for (const action of prepared.casePlan.when) {
    const node = action.do === "cancelRun" ? action.at : action.node;
    const occurrence = nextOccurrence(occurrences, node);
    switch (action.do) {
      case "answerQuestion":
        await answerAgentQuestion(h, runCase, action, node, occurrence, visits);
        break;
      case "retryAgent":
        await decideRetry(h, runCase, action, node, occurrence, visits);
        break;
      case "chooseGate":
        await chooseGraphGate(
          h,
          prepared,
          catalog,
          runCase,
          action,
          node,
          occurrence,
          visits,
        );
        break;
      case "overrideMerge":
        await overrideMergeGate(
          h,
          prepared,
          catalog,
          runCase,
          action,
          node,
          occurrence,
          visits,
        );
        break;
      case "rejectGate":
        await rejectGraphGate(
          h,
          prepared,
          catalog,
          runCase,
          action,
          node,
          occurrence,
          visits,
        );
        break;
      case "cancelRun":
        await cancelRunAtGate(
          h,
          prepared,
          catalog,
          runCase,
          action,
          node,
          occurrence,
          visits,
        );
        break;
    }
  }
}
export async function executeCase(
  h: HostFixture,
  casePlan: PipelineCase,
  targets: WeakMap<object, TargetRepo>,
): Promise<void> {
  const prepared = validateCasePreflight(casePlan, targets);
  const given = prepared.casePlan.given;
  const { created, catalog } = await createCase(h, prepared);
  validateActions(prepared.casePlan.when, catalog);
  const runCase: StartedPipelineCase = {
    runId: created.runId,
    taskId: created.taskId,
    ghCallBoundary: caseGhCallBoundary(h.ghCalls),
    title: prepared.title,
    coverage: prepared.casePlan.coverage,
    ...(given.github ? { gh: given.github } : {}),
    ...(given.integrator ? { integrator: given.integrator } : {}),
    ...(given.agent ? { agent: given.agent as AgentSpec } : {}),
    ...(given.developerWrite === false
      ? {}
      : { developerWrite: prepared.repo }),
    ...(given.cleanup ? { cleanup: given.cleanup } : {}),
  };
  h.casePlans.register(created.taskId, {
    title: prepared.title,
    ...(runCase.gh ? { gh: runCase.gh } : {}),
    ...(runCase.integrator ? { integrator: runCase.integrator } : {}),
    ...(runCase.agent ? { agent: runCase.agent } : {}),
    ...(runCase.developerWrite
      ? { developerWrite: runCase.developerWrite }
      : {}),
    ...(runCase.cleanup ? { cleanup: runCase.cleanup } : {}),
  });
  const started = await h.api.startRun({ runId: created.runId });
  runCase.engine = "engine" in started ? started.engine : undefined;
  const visits = new Map<string, GateVisitRecord>();
  await executeActions(h, prepared, catalog, visits, runCase);
  const terminal = await waitState(h.api, created.runId);
  await assertCaseExpectations(h, prepared.casePlan, runCase, terminal, visits);
}
