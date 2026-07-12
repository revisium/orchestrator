import assert from "node:assert/strict";
import type { TaskControlPlaneApiService } from "../../task-control-plane/task-control-plane-api.service.js";
import { taskBranchPrefix } from "../../runners/integrator-branch-naming.js";
import { worktreePathFor } from "../../control-plane/resolve-cwd.js";
import { getConfig } from "../../config.js";
import { reviewReplyBodiesSince } from "./gh-call-log.js";
import type {
  PipelineEventMatch,
  PipelineEventType,
  PipelineExpectation,
  PipelineSideEffect,
} from "./pipeline-case.js";

export type ObservedRunEvent = Awaited<
  ReturnType<TaskControlPlaneApiService["getRunEvents"]>
>[number];

export type EventObservationClock = Readonly<{
  sleep(milliseconds: number): Promise<void>;
}>;

const realClock: EventObservationClock = Object.freeze({
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
});

type PositiveRequirement = (events: readonly ObservedRunEvent[]) => boolean;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matchesSideEffect(
  call: readonly string[],
  effect: PipelineSideEffect,
): boolean {
  if (effect === "create_pull_request")
    return call[0] === "pr" && call[1] === "create";
  if (effect === "merge_pull_request")
    return call[0] === "pr" && call[1] === "merge";
  return (
    call[0] === "pr" &&
    call[1] === "list" &&
    call.includes("--state") &&
    call.includes(effect === "list_open_pull_requests" ? "open" : "all")
  );
}

function agentCallsFor(
  h: import("./harness.js").HostFixture,
  runId: string,
  role: string,
) {
  return h.agentCalls.filter(
    (call) => call.runId === runId && call.role === role,
  );
}

function repoFromContext(context: string): string {
  const repo = /^Repo: (.+)$/m.exec(context)?.[1]?.trim();
  assert.ok(repo, "agent context must include the execution repository");
  return repo;
}

function retryContext(stepInput: unknown): Record<string, unknown> {
  const input = record(stepInput);
  const value = input?.["retryContext"];
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "agent retry must include retryContext",
  );
  return value as Record<string, unknown>;
}

function assertReviewReply(
  h: import("./harness.js").HostFixture,
  runCase: import("./pipeline-case-executor.js").StartedPipelineCase,
  expected: string,
): void {
  const bodies = reviewReplyBodiesSince(h.ghCalls, runCase.ghCallBoundary);
  assert.ok(
    bodies.some((body) => body.includes(expected)),
    `review reply must include ${JSON.stringify(expected)}`,
  );
}

export function assertGatePresentation(
  expectation: Extract<
    PipelineExpectation,
    {
      check:
        | "gateSummary"
        | "gateOptions"
        | "planGateArtifact"
        | "gateArtifactHead";
    }
  >,
  visits: ReadonlyMap<
    string,
    import("./pipeline-case-executor.js").GateVisitRecord
  >,
): void {
  const observed = visits.get(
    `${expectation.at.node}#${expectation.at.occurrence}`,
  );
  assert.ok(
    observed,
    `missing gate visit ${expectation.at.node}#${expectation.at.occurrence}`,
  );
  if (expectation.check === "gateOptions")
    return assert.deepEqual(observed.gate.options, expectation.equals);
  if (expectation.check === "gateSummary")
    return assert.ok(
      JSON.stringify(observed.gate.context.summary).includes(
        expectation.contains,
      ),
    );
  const summary = record(observed.gate.context.summary);
  const artifact = record(summary?.["gatedArtifact"]);
  if (expectation.check === "gateArtifactHead")
    return assert.equal(
      record(artifact?.["payload"])?.["headSha"],
      expectation.equals,
    );
  assert.equal(artifact?.["nodeId"], expectation.source.nodeId);
  assert.equal(artifact?.["name"], expectation.source.name);
  assert.ok(
    artifact?.["payload"] !== undefined || artifact?.["preview"] !== undefined,
  );
  assert.ok(summary?.["reviewerVerdict"]);
}

export function eventMatches(
  event: ObservedRunEvent,
  expected: PipelineEventMatch,
): boolean {
  if (event.type !== expected.type) return false;
  if (!("where" in expected) || expected.where === undefined) return true;
  const payload = record(event.payload);
  return (
    payload !== undefined &&
    Object.entries(expected.where).every(
      ([key, value]) => payload[key] === value,
    )
  );
}

function pathMatches(
  events: readonly ObservedRunEvent[],
  path: readonly PipelineEventMatch[],
): boolean {
  let from = 0;
  for (const expected of path) {
    const found = events.findIndex(
      (event, index) => index >= from && eventMatches(event, expected),
    );
    if (found < 0) return false;
    from = found + 1;
  }
  return true;
}

function blockedDecisionMatches(
  events: readonly ObservedRunEvent[],
  expectation: Extract<PipelineExpectation, { check: "blockedDecision" }>,
): boolean {
  return events.some((event) => {
    if (event.type !== "pipeline_blocked") return false;
    const payload = record(event.payload);
    return (
      payload?.["reason"] === expectation.reason &&
      expectation.lessonContains.every((text) =>
        String(payload["lesson"] ?? "").includes(text),
      )
    );
  });
}

function failureReasonMatches(
  events: readonly ObservedRunEvent[],
  expectation: Extract<PipelineExpectation, { check: "failureReason" }>,
): boolean {
  return events.some(
    (event) =>
      event.type === "run_failed" &&
      expectation.contains.every((text) =>
        String(record(event.payload)?.["reason"] ?? "").includes(text),
      ),
  );
}

function hasRoleStepAfterEvent(
  events: readonly ObservedRunEvent[],
  expectation: Extract<PipelineExpectation, { check: "roleAfterEvent" }>,
): boolean {
  const eventIndex = events.findIndex(
    (event) => event.type === expectation.event,
  );
  if (eventIndex < 0) return false;
  return events.some(
    (event, index) =>
      index > eventIndex &&
      event.type === "step_succeeded" &&
      String(record(event.payload)?.["role"] ?? "").endsWith(expectation.role),
  );
}

function positiveRequirements(
  expectations: readonly PipelineExpectation[],
): PositiveRequirement[] {
  return expectations.flatMap((expectation): PositiveRequirement[] => {
    if (expectation.check === "event")
      return [
        (events) =>
          events.some((event) => eventMatches(event, expectation.event)),
      ];
    if (expectation.check === "eventPath")
      return [(events) => pathMatches(events, expectation.events)];
    if (expectation.check === "blockedDecision")
      return [(events) => blockedDecisionMatches(events, expectation)];
    if (expectation.check === "failureReason")
      return [(events) => failureReasonMatches(events, expectation)];
    if (expectation.check === "roleAfterEvent")
      return [(events) => hasRoleStepAfterEvent(events, expectation)];
    return [];
  });
}

function eventBacked(expectations: readonly PipelineExpectation[]): boolean {
  return expectations.some(
    (expectation) =>
      expectation.check === "event" ||
      expectation.check === "eventPath" ||
      expectation.check === "blockedDecision" ||
      expectation.check === "failureReason" ||
      expectation.check === "roleAfterEvent" ||
      expectation.check === "forbiddenEvent" ||
      expectation.check === "persistedEvents",
  );
}

function assertForbidden(
  events: readonly ObservedRunEvent[],
  forbidden: ReadonlySet<PipelineEventType>,
): void {
  for (const event of events)
    assert.ok(
      !forbidden.has(event.type as PipelineEventType),
      `forbidden pipeline event observed: ${event.type}`,
    );
}

export class EventObservationSession {
  readonly #api: TaskControlPlaneApiService;
  readonly #runId: string;
  readonly #clock: EventObservationClock;

  constructor(
    api: TaskControlPlaneApiService,
    runId: string,
    clock: EventObservationClock = realClock,
  ) {
    this.#api = api;
    this.#runId = runId;
    this.#clock = clock;
  }

  async collect(
    expectations: readonly PipelineExpectation[],
  ): Promise<readonly ObservedRunEvent[]> {
    if (!eventBacked(expectations)) return Object.freeze([]);

    const required = positiveRequirements(expectations);
    const forbidden = new Set(
      expectations
        .filter(
          (
            expectation,
          ): expectation is Extract<
            PipelineExpectation,
            { check: "forbiddenEvent" }
          > => expectation.check === "forbiddenEvent",
        )
        .map((expectation) => expectation.type),
    );
    const redactions = expectations
      .filter(
        (
          expectation,
        ): expectation is Extract<
          PipelineExpectation,
          { check: "persistedEvents" }
        > => expectation.check === "persistedEvents",
      )
      .map((expectation) => expectation.excludes);
    let events = await this.#api.getRunEvents({
      runId: this.#runId,
      limit: 500,
    });

    for (
      let elapsed = 0;
      required.some((requirement) => !requirement(events)) && elapsed < 8_000;
      elapsed += 250
    ) {
      await this.#clock.sleep(250);
      events = await this.#api.getRunEvents({ runId: this.#runId, limit: 500 });
    }
    assert.ok(
      required.every((requirement) => requirement(events)),
      "required pipeline event evidence was not observed",
    );

    if (forbidden.size > 0) {
      assertForbidden(events, forbidden);
      for (let elapsed = 100; elapsed <= 1_000; elapsed += 100) {
        await this.#clock.sleep(100);
        events = await this.#api.getRunEvents({
          runId: this.#runId,
          limit: 500,
        });
        assertForbidden(events, forbidden);
      }
    }

    for (const needle of redactions)
      assert.ok(
        !JSON.stringify(events).includes(needle),
        `persisted event snapshot contains ${JSON.stringify(needle)}`,
      );
    return Object.freeze([...events]);
  }
}

export function deepFreezeCase<T>(
  value: T,
  seen = new WeakSet<object>(),
  skip = new WeakSet<object>(),
): T {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value) ||
    skip.has(value)
  )
    return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeCase(item, seen, skip);
  } else {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreezeCase(child, seen, skip);
  }
  Object.freeze(value);
  return value;
}

export type CaseEvidence = Readonly<{
  h: import("./harness.js").HostFixture;
  runCase: import("./pipeline-case-executor.js").StartedPipelineCase;
  terminal: Awaited<ReturnType<typeof import("./drive.js").waitState>>;
  events: readonly ObservedRunEvent[];
  visits: ReadonlyMap<
    string,
    import("./pipeline-case-executor.js").GateVisitRecord
  >;
  workflow?: Awaited<ReturnType<TaskControlPlaneApiService["getRunWorkflow"]>>;
}>;

export type ExpectationHandler<K extends PipelineExpectation["check"]> = (
  expectation: Extract<PipelineExpectation, { check: K }>,
  evidence: CaseEvidence,
) => void | Promise<void>;

function eventExpectation(
  expectation: Extract<PipelineExpectation, { check: "event" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(
    evidence.events.some((event) => eventMatches(event, expectation.event)),
  );
}

function eventPathExpectation(
  expectation: Extract<PipelineExpectation, { check: "eventPath" }>,
  evidence: CaseEvidence,
): void {
  let start = 0;
  for (const expected of expectation.events) {
    const found = evidence.events.findIndex(
      (event, index) => index >= start && eventMatches(event, expected),
    );
    assert.ok(found >= start, "event path is incomplete");
    start = found + 1;
  }
}

function terminalExpectation(
  expectation: Extract<PipelineExpectation, { check: "terminal" }>,
  evidence: CaseEvidence,
): void {
  assert.equal(evidence.terminal.state, expectation.equals);
}

function engineExpectation(
  expectation: Extract<PipelineExpectation, { check: "engine" }>,
  evidence: CaseEvidence,
): void {
  assert.equal(evidence.runCase.engine, expectation.equals);
}

function forbiddenEventExpectation(
  expectation: Extract<PipelineExpectation, { check: "forbiddenEvent" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(!evidence.events.some((event) => event.type === expectation.type));
}

function blockedDecisionExpectation(
  expectation: Extract<PipelineExpectation, { check: "blockedDecision" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(
    evidence.events.some((event) => {
      const payload = record(event.payload);
      return (
        event.type === "pipeline_blocked" &&
        payload?.["reason"] === expectation.reason &&
        expectation.lessonContains.every((needle) =>
          String(payload?.["lesson"] ?? "").includes(needle),
        )
      );
    }),
  );
}

function failureReasonExpectation(
  expectation: Extract<PipelineExpectation, { check: "failureReason" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(
    evidence.events.some(
      (event) =>
        event.type === "run_failed" &&
        expectation.contains.every((needle) =>
          String(record(event.payload)?.["reason"] ?? "").includes(needle),
        ),
    ),
  );
}

function roleAfterEventExpectation(
  expectation: Extract<PipelineExpectation, { check: "roleAfterEvent" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(hasRoleStepAfterEvent(evidence.events, expectation));
}

function sideEffectExpectation(
  expectation: Extract<PipelineExpectation, { check: "sideEffect" }>,
  evidence: CaseEvidence,
): void {
  const prefix = taskBranchPrefix(evidence.runCase.taskId);
  const present = evidence.h.ghCalls.some(
    (call) =>
      call.some((arg) => arg.startsWith(prefix)) &&
      matchesSideEffect(call, expectation.effect),
  );
  assert.equal(present, expectation.presence === "required");
}

function roleCalledExpectation(
  expectation: Extract<PipelineExpectation, { check: "roleCalled" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(
    agentCallsFor(evidence.h, evidence.runCase.runId, expectation.role).length >
      0,
  );
}

function nodeCalledExpectation(
  expectation: Extract<PipelineExpectation, { check: "nodeCalled" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(
    evidence.h.agentCalls.some(
      (call) =>
        call.runId === evidence.runCase.runId &&
        call.nodeId === expectation.node,
    ),
  );
}

function roleCallCountExpectation(
  expectation: Extract<PipelineExpectation, { check: "roleCallCount" }>,
  evidence: CaseEvidence,
): void {
  const count = agentCallsFor(
    evidence.h,
    evidence.runCase.runId,
    expectation.role,
  ).length;
  if ("exact" in expectation.count)
    assert.equal(count, expectation.count.exact);
  else assert.ok(count >= expectation.count.minimum);
}

function roleWorktreeExpectation(
  expectation: Extract<PipelineExpectation, { check: "roleWorktree" }>,
  evidence: CaseEvidence,
): void {
  assert.deepEqual(
    [
      ...new Set(
        agentCallsFor(evidence.h, evidence.runCase.runId, expectation.role).map(
          (call) => repoFromContext(call.context),
        ),
      ),
    ],
    [worktreePathFor(getConfig().dataDir, evidence.runCase.runId)],
  );
}

function roleRetryContextExpectation(
  expectation: Extract<PipelineExpectation, { check: "roleRetryContext" }>,
  evidence: CaseEvidence,
): void {
  const calls = agentCallsFor(
    evidence.h,
    evidence.runCase.runId,
    expectation.role,
  );
  const actual = retryContext(calls[expectation.callIndex]?.stepInput);
  assert.equal(actual["kind"], expectation.equals.kind);
  assert.equal(actual["nodeId"], expectation.equals.nodeId);
  assert.deepEqual(actual["answer"], expectation.equals.answer);
  assert.equal(actual["lesson"], expectation.equals.lesson);
  assert.equal(actual["resolvedBy"], expectation.equals.resolvedBy);
  if (expectation.distinctInboxFromCallIndex !== undefined) {
    assert.notEqual(
      actual["inboxId"],
      retryContext(calls[expectation.distinctInboxFromCallIndex]?.stepInput)[
        "inboxId"
      ],
    );
  }
}

function roleContextExpectation(
  expectation: Extract<PipelineExpectation, { check: "roleContext" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(
    agentCallsFor(evidence.h, evidence.runCase.runId, expectation.role)
      .map((call) => call.context)
      .join("\n")
      .includes(expectation.contains),
  );
}

function reviewerConsensusExpectation(
  expectation: Extract<PipelineExpectation, { check: "reviewerConsensus" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(evidence.workflow, "reviewer workflow evidence was not collected");
  const reviewers = evidence.workflow.nodes.filter(
    (node) => node.roleId === "reviewer",
  );
  assert.deepEqual(
    reviewers.map((node) => node.id).sort(),
    [...expectation.nodeIds].sort(),
  );
  assert.deepEqual(
    reviewers.map((node) => node.verdict).sort(),
    [...expectation.verdicts].sort(),
  );
  assert.ok(reviewers.every((node) => node.attemptCount === 1));
  if (expectation.attemptVerdicts !== undefined)
    assert.deepEqual(
      evidence.workflow.attempts.map((attempt) => attempt.verdict).sort(),
      [...expectation.attemptVerdicts].sort(),
    );
  if (expectation.processArtifacts === "required")
    assert.ok(
      evidence.workflow.attempts.every((attempt) =>
        attempt.artifactRef?.startsWith("test-artifacts/"),
      ),
    );
}

function persistedEventsExpectation(
  expectation: Extract<PipelineExpectation, { check: "persistedEvents" }>,
  evidence: CaseEvidence,
): void {
  assert.ok(!JSON.stringify(evidence.events).includes(expectation.excludes));
}

function reviewReplyExpectation(
  expectation: Extract<PipelineExpectation, { check: "reviewReply" }>,
  evidence: CaseEvidence,
): void {
  assertReviewReply(evidence.h, evidence.runCase, expectation.contains);
}

function pendingGateRiskExpectation(
  expectation: Extract<PipelineExpectation, { check: "pendingGateRisk" }>,
  evidence: CaseEvidence,
): void {
  const visit = evidence.visits.get(
    `${expectation.at.node}#${expectation.at.occurrence}`,
  );
  assert.ok(visit?.risk);
  assert.equal(visit.risk.topic, expectation.equals.topic);
  assert.equal(visit.risk.kind, expectation.equals.kind);
}

type PresentationCheck =
  | "gateSummary"
  | "gateOptions"
  | "planGateArtifact"
  | "gateArtifactHead";
const presentationExpectation: ExpectationHandler<PresentationCheck> = (
  expectation,
  evidence,
) => {
  assertGatePresentation(expectation, evidence.visits);
};

export function expectationHandlers(): {
  [K in PipelineExpectation["check"]]: ExpectationHandler<K>;
} {
  return {
    terminal: terminalExpectation,
    engine: engineExpectation,
    event: eventExpectation,
    eventPath: eventPathExpectation,
    forbiddenEvent: forbiddenEventExpectation,
    blockedDecision: blockedDecisionExpectation,
    failureReason: failureReasonExpectation,
    sideEffect: sideEffectExpectation,
    roleCalled: roleCalledExpectation,
    nodeCalled: nodeCalledExpectation,
    roleCallCount: roleCallCountExpectation,
    roleWorktree: roleWorktreeExpectation,
    roleRetryContext: roleRetryContextExpectation,
    roleContext: roleContextExpectation,
    roleAfterEvent: roleAfterEventExpectation,
    reviewerConsensus: reviewerConsensusExpectation,
    persistedEvents: persistedEventsExpectation,
    reviewReply: reviewReplyExpectation,
    gateSummary: (expectation, evidence) =>
      presentationExpectation(expectation, evidence),
    gateOptions: (expectation, evidence) =>
      presentationExpectation(expectation, evidence),
    pendingGateRisk: pendingGateRiskExpectation,
    planGateArtifact: (expectation, evidence) =>
      presentationExpectation(expectation, evidence),
    gateArtifactHead: (expectation, evidence) =>
      presentationExpectation(expectation, evidence),
  };
}

type ExpectationHandlers = ReturnType<typeof expectationHandlers>;

async function dispatchExpectation<K extends PipelineExpectation["check"]>(
  handlers: ExpectationHandlers,
  expectation: Extract<PipelineExpectation, { check: K }>,
  evidence: CaseEvidence,
): Promise<void> {
  // TypeScript does not preserve the discriminant correlation through indexed
  // access; this adapter asserts only that one keyed handler, while the
  // mapped table above still requires every PipelineExpectation key.
  const handler = handlers[expectation.check] as ExpectationHandler<K>;
  await handler(expectation, evidence);
}

export async function assertCaseExpectations(
  h: import("./harness.js").HostFixture,
  casePlan: import("./pipeline-case.js").PipelineCase,
  runCase: import("./pipeline-case-executor.js").StartedPipelineCase,
  terminal: Awaited<ReturnType<typeof import("./drive.js").waitState>>,
  visits: ReadonlyMap<
    string,
    import("./pipeline-case-executor.js").GateVisitRecord
  >,
): Promise<void> {
  const events = await new EventObservationSession(
    h.api,
    runCase.runId,
  ).collect(casePlan.then);
  const needsWorkflow = casePlan.then.some(
    (expectation) => expectation.check === "reviewerConsensus",
  );
  const workflow = needsWorkflow
    ? await h.api.getRunWorkflow(runCase.runId)
    : undefined;
  const evidence: CaseEvidence = {
    h,
    runCase,
    terminal,
    events,
    visits,
    ...(workflow ? { workflow } : {}),
  };
  const handlers = expectationHandlers();
  for (const expectation of casePlan.then) {
    await dispatchExpectation(handlers, expectation, evidence);
  }
}
