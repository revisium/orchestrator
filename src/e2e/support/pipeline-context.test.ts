import assert from "node:assert/strict";
import test from "node:test";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { coverageForScenario } from "../../testing/policy/pipeline-coverage.js";
import type { HostFixture } from "./harness.js";
import { PipelineContext } from "./pipeline-context.js";
import {
  answerQuestion,
  chooseGate,
  expectTerminal,
  expectEvent,
  overrideMerge,
  retryAgent,
  type PipelineCase,
} from "./pipeline-case.js";
import { hashTemplate } from "../../pipeline-core/materialize.js";
import { deepFreezeCase } from "./pipeline-case-evidence.js";

const TEST_TEMPLATE = {
  specVersion: "1.0",
  pipelineId: "feature-development",
  entry: "planGate",
  verdicts: { domain: ["approved"] },
  nodes: {
    planGate: {
      id: "planGate",
      kind: "humanGate",
      reason: "task spec approval",
      outcomes: ["approved"],
      branches: [
        { when: { op: "verdict.eq", value: "approved" }, goto: "analyst" },
        { default: "done" },
      ],
    },
    done: { id: "done", kind: "terminal", status: "succeeded" },
    analyst: {
      id: "analyst",
      kind: "agent",
      roleRef: "role:analyst",
      next: "developer",
    },
    developer: {
      id: "developer",
      kind: "agent",
      roleRef: "role:developer",
      next: "done",
    },
  },
} as const;
const testRoute = () => ({
  playbookId: "revisium-agent-playbook",
  pipelineId: "feature-development",
  executionPolicy: { template_json: TEST_TEMPLATE },
  materializedTemplate: TEST_TEMPLATE,
  materializedTemplateHash: hashTemplate(TEST_TEMPLATE as never),
  profileSource: "inline" as const,
});
const routeWithAnalystRole = (roleRef: string) => {
  const template = {
    ...TEST_TEMPLATE,
    nodes: {
      ...TEST_TEMPLATE.nodes,
      analyst: { ...TEST_TEMPLATE.nodes.analyst, roleRef },
    },
  } as const;
  return {
    ...testRoute(),
    executionPolicy: { template_json: template },
    materializedTemplate: template,
    materializedTemplateHash: hashTemplate(template as never),
  };
};
const routeWithDeveloperRole = (roleRef: string) => {
  const template = {
    ...TEST_TEMPLATE,
    nodes: {
      ...TEST_TEMPLATE.nodes,
      developer: { ...TEST_TEMPLATE.nodes.developer, roleRef },
    },
  } as const;
  return {
    ...testRoute(),
    executionPolicy: { template_json: template },
    materializedTemplate: template,
    materializedTemplateHash: hashTemplate(template as never),
  };
};

function pendingGateHost(
  gate: {
    topic: string;
    options: readonly string[];
    nodeId: string;
    kind?: string;
    question?: boolean;
    summaryKind?: string;
  },
  route: unknown = testRoute(),
) {
  let resolved = false;
  const mutations = { register: 0, start: 0, resolve: 0, reject: 0, cancel: 0 };
  const host = {
    api: {
      async createRun() {
        return { runId: "run-1", taskId: "task-1", route };
      },
      async startRun() {
        mutations.start += 1;
        return { alreadyStarted: false };
      },
      async waitForRun() {
        return resolved
          ? {
              state: "completed",
              workflowStatus: "SUCCESS",
              runStatus: "completed",
              nextAction: "",
              runId: "run-1",
            }
          : {
              state: gate.question ? "question" : "pending_gate",
              workflowStatus: "PENDING",
              runStatus: "running",
              nextAction: "",
              runId: "run-1",
              inbox: {
                id: "inbox-1",
                context: {
                  topic: gate.topic,
                  summary: {
                    kind: gate.summaryKind ?? gate.kind ?? "approval",
                    nodeId: gate.nodeId,
                    outcomes: [...gate.options],
                    taskId: "task-1",
                    step: "step",
                    runner: "runner",
                    lesson: "lesson",
                    attemptId: "attempt",
                  },
                },
                options: [...gate.options],
              },
            };
      },
      async resolveGate() {
        mutations.resolve += 1;
        resolved = true;
        return {};
      },
      async rejectGate() {
        mutations.reject += 1;
        resolved = true;
        return {};
      },
      async cancelRun() {
        mutations.cancel += 1;
        resolved = true;
        return {};
      },
      async answerQuestion() {
        mutations.resolve += 1;
        resolved = true;
        return {};
      },
    },
    casePlans: {
      register() {
        mutations.register += 1;
      },
    },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  return { host, mutations };
}

function baseCase(when: PipelineCase["when"][number]): PipelineCase {
  return {
    coverage: nonDslPipelineCaseAttachment("B3"),
    given: { repo: "workspace", developerWrite: false },
    when: [when],
    then: [expectTerminal("completed")],
  };
}

test("pipeline context exposes the lifecycle surface without the legacy run method", () => {
  assert.equal(typeof PipelineContext.prototype.execute, "function");
  assert.equal(typeof PipelineContext.prototype.target, "function");
  assert.equal(typeof PipelineContext.prototype.close, "function");
  assert.equal("run" in PipelineContext.prototype, false);
});

test("pipeline context rejects added gate options before resolving the gate", async () => {
  let resolved = false;
  const resolvedInputs: unknown[] = [];
  const host = {
    api: {
      async createRun() {
        return { runId: "run-1", taskId: "task-1", route: testRoute() };
      },
      async startRun() {
        return { alreadyStarted: false };
      },
      async waitForRun() {
        if (resolved) {
          return {
            state: "completed",
            workflowStatus: "SUCCESS",
            runStatus: "completed",
            nextAction: "",
            runId: "run-1",
          };
        }
        return {
          state: "pending_gate",
          workflowStatus: "PENDING",
          runStatus: "running",
          nextAction: "",
          runId: "run-1",
          inbox: {
            id: "inbox-1",
            context: {
              topic: "plan",
              summary: { outcomes: ["approved", "surprise"] },
            },
            options: ["approved", "surprise"],
          },
        };
      },
      async resolveGate(input: unknown) {
        resolvedInputs.push(input);
        resolved = true;
        return {};
      },
    },
    casePlans: { register() {} },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  const pipeline = new PipelineContext(host);

  await assert.rejects(
    () =>
      pipeline.execute({
        coverage: nonDslPipelineCaseAttachment("B3"),
        given: { repo: "workspace", developerWrite: false },
        when: [chooseGate("planGate", "approved")],
        then: [expectTerminal("completed")],
      }),
    /unexpected plan gate options/,
  );
  assert.deepEqual(resolvedInputs, []);
});

test("pipeline context rejects a registered attachment bound to another profile before creating a run", async () => {
  let createCalls = 0;
  const host = {
    api: {
      async createRun() {
        createCalls += 1;
        throw new Error("run creation must not execute");
      },
    },
  } as unknown as HostFixture;
  const pipeline = new PipelineContext(host);

  await assert.rejects(
    () =>
      pipeline.execute({
        coverage: coverageForScenario("M1-profile-single"),
        given: {
          repo: "workspace",
          playbook: "default",
          profileId: "claude-standard",
          developerWrite: false,
        },
        when: [],
        then: [expectTerminal("completed")],
      }),
    /registered pipeline attachment does not match the selected materialized identity/,
  );
  assert.equal(createCalls, 0);
});

test("pipeline context executes the canonical coverage/given/when/then descriptor", async () => {
  let resolved = false;
  const host = {
    api: {
      async createRun(input: Record<string, unknown>) {
        assert.equal(input["title"], "B3");
        return { runId: "run-1", taskId: "task-1", route: testRoute() };
      },
      async startRun() {
        return { alreadyStarted: false };
      },
      async waitForRun() {
        return resolved
          ? {
              state: "completed",
              workflowStatus: "SUCCESS",
              runStatus: "completed",
              nextAction: "",
              runId: "run-1",
            }
          : {
              state: "pending_gate",
              workflowStatus: "PENDING",
              runStatus: "running",
              nextAction: "",
              runId: "run-1",
              inbox: {
                id: "inbox-1",
                context: {
                  topic: "plan",
                  summary: { nodeId: "planGate", outcomes: ["approved"] },
                },
                options: ["approved"],
              },
            };
      },
      async resolveGate() {
        resolved = true;
        return {};
      },
    },
    casePlans: { register() {} },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  const pipeline = new PipelineContext(host);
  const descriptor: PipelineCase = {
    coverage: nonDslPipelineCaseAttachment("B3"),
    given: { repo: "workspace", developerWrite: false },
    when: [chooseGate("planGate", "approved")],
    then: [expectTerminal("completed")],
  };

  await pipeline.execute(descriptor);
  assert.equal(resolved, true);
});

test("pipeline case declarations are deeply immutable after execute entry", async () => {
  let resolved = false;
  const host = {
    api: {
      async createRun() {
        return { runId: "run-1", taskId: "task-1", route: testRoute() };
      },
      async startRun() {
        return { alreadyStarted: false };
      },
      async waitForRun() {
        return resolved
          ? {
              state: "completed",
              workflowStatus: "SUCCESS",
              runStatus: "completed",
              nextAction: "",
              runId: "run-1",
            }
          : {
              state: "pending_gate",
              workflowStatus: "PENDING",
              runStatus: "running",
              nextAction: "",
              runId: "run-1",
              inbox: {
                id: "inbox-1",
                context: {
                  topic: "plan",
                  summary: { nodeId: "planGate", outcomes: ["approved"] },
                },
                options: ["approved"],
              },
            };
      },
      async resolveGate() {
        resolved = true;
        return {};
      },
    },
    casePlans: { register() {} },
    agentCalls: [],
    ghCalls: [],
  } as unknown as HostFixture;
  const action: PipelineCase["when"][number] = chooseGate(
    "planGate",
    "approved",
  );

  await new PipelineContext(host).execute({
    coverage: nonDslPipelineCaseAttachment("B3"),
    given: { repo: "workspace", developerWrite: false },
    when: [action],
    then: [expectTerminal("completed")],
  });
  assert.equal(resolved, true);
  assert.throws(
    () => ((action as { node: string }).node = "mergeGate"),
    TypeError,
  );
});

test("pipeline context rejects every graph presentation drift before mutation", async () => {
  const cases = [
    [
      "wrong topic",
      { topic: "merge", options: ["approved"], nodeId: "planGate" },
    ],
    ["wrong node", { topic: "plan", options: ["approved"], nodeId: "other" }],
    [
      "added outcome",
      { topic: "plan", options: ["approved", "cancel"], nodeId: "planGate" },
    ],
    [
      "reordered outcome",
      { topic: "plan", options: ["cancel", "approved"], nodeId: "planGate" },
    ],
  ] as const;
  for (const [label, gate] of cases) {
    const { host, mutations } = pendingGateHost(gate);
    await assert.rejects(
      () =>
        new PipelineContext(host).execute(
          baseCase(chooseGate("planGate", "approved")),
        ),
      label === "wrong topic"
        ? /expected plan gate/
        : /unexpected plan gate options|expected plan gate node/,
    );
    assert.deepEqual(mutations, {
      register: 1,
      start: 1,
      resolve: 0,
      reject: 0,
      cancel: 0,
    });
  }
});

test("pipeline context rejects Stage B route template and provenance drift before lifecycle mutation", async () => {
  const routes = [
    { ...testRoute(), materializedTemplateHash: "wrong-hash" },
    {
      ...testRoute(),
      profileSource: "stored" as const,
      profileId: "wrong-profile",
    },
  ];
  for (const route of routes) {
    const { host, mutations } = pendingGateHost(
      { topic: "plan", options: ["approved"], nodeId: "planGate" },
      route,
    );
    await assert.rejects(
      () =>
        new PipelineContext(host).execute(
          baseCase(chooseGate("planGate", "approved")),
        ),
      /hash mismatch|profile provenance mismatch/,
    );
    assert.deepEqual(mutations, {
      register: 0,
      start: 0,
      resolve: 0,
      reject: 0,
      cancel: 0,
    });
  }
});

test("pipeline context rejects unpinned analyst and developer action nodes before lifecycle mutation", async () => {
  const cases = [
    ["question", answerQuestion("analyst", "answer")],
    ["retry", retryAgent("developer", "give_up")],
  ] as const;
  for (const [label, action] of cases) {
    const route =
      label === "question"
        ? routeWithAnalystRole("role:other")
        : routeWithDeveloperRole("role:other");
    const { host, mutations } = pendingGateHost(
      {
        topic: "question",
        options: [],
        nodeId: "analyst",
        question: true,
        summaryKind: "agent_question",
      },
      route,
    );
    await assert.rejects(
      () => new PipelineContext(host).execute(baseCase(action)),
      /pinned analyst agent|pinned developer agent/,
    );
    assert.deepEqual(mutations, {
      register: 0,
      start: 0,
      resolve: 0,
      reject: 0,
      cancel: 0,
    });
  }
});

test("pipeline context rejects wrong retry and question evidence without resolving", async () => {
  const retryCases = [
    { kind: "approval", nodeId: "developer", options: ["retry", "give_up"] },
    { kind: "transient_retry", nodeId: "other", options: ["retry", "give_up"] },
    { kind: "transient_retry", nodeId: "developer", options: ["retry"] },
  ] as const;
  for (const gate of retryCases) {
    const { host, mutations } = pendingGateHost({ topic: "retry", ...gate });
    await assert.rejects(
      () =>
        new PipelineContext(host).execute(
          baseCase(retryAgent("developer", "give_up")),
        ),
      /expected|deep-equal|transient_retry|developer/,
    );
    assert.equal(mutations.resolve, 0);
  }
  for (const nodeId of ["other"] as const) {
    const { host, mutations } = pendingGateHost({
      topic: "question",
      options: [],
      nodeId,
      question: true,
      summaryKind: "wrong_kind",
    });
    await assert.rejects(
      () =>
        new PipelineContext(host).execute(
          baseCase(answerQuestion("analyst", "answer")),
        ),
      /agent_question/,
    );
    assert.equal(mutations.resolve, 0);
  }
});

test("pipeline case freezing preserves canonical coverage identity and freezes nested evidence inputs", () => {
  const coverage = coverageForScenario("M1-profile-single");
  const audit = {
    threadIds: ["thread-1"],
    actor: "human",
    reason: "reason",
    risk: "risk",
    verificationResponsibility: "owner",
    headSha: "sha",
  } as const;
  const question = answerQuestion("analyst", { answer: { nested: ["value"] } });
  const merge = overrideMerge("note", audit);
  const event = expectEvent({ type: "run_completed" });
  const terminal = expectTerminal("completed");
  const descriptor = {
    coverage,
    given: {
      repo: "workspace" as const,
      playbook: "default" as const,
      profile: "default-agent" as const,
      agent: { default: { kind: "pass" as const } },
      cleanup: { releaseWorktreeFails: true },
    },
    when: [question, merge],
    then: [event, terminal],
  } satisfies PipelineCase;
  deepFreezeCase(descriptor, new WeakSet<object>(), new WeakSet<object>());
  assert.strictEqual(descriptor.coverage, coverage);
  assert.ok(Object.isFrozen(descriptor.coverage));
  assert.ok(Object.isFrozen(question.answer));
  assert.ok(Object.isFrozen(merge.audit));
  assert.ok(Object.isFrozen(merge.audit.threadIds));
  assert.ok(Object.isFrozen(descriptor.given.agent));
  assert.ok(Object.isFrozen(descriptor.given.cleanup));
  assert.ok(Object.isFrozen(event.event));
  assert.ok(Object.isFrozen(descriptor.then));
});
