import { before, after, test } from "node:test";
import { coverageForScenario } from "../../testing/policy/pipeline-coverage.js";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import {
  answerQuestion,
  chooseGate,
  expectEvent,
  expectEventPath,
  expectTerminal,
  forbidEvent,
  gateVisit,
  retryAgent,
  type PipelineAgentPlan,
} from "../support/pipeline-case.js";
import {
  createPipelineContext,
  type PipelineContext,
} from "../support/pipeline-context.js";
let pipeline: PipelineContext;
before(async () => {
  if (RUN_REAL_E2E) pipeline = await createPipelineContext();
});
after(async () => {
  if (pipeline) await pipeline.close();
});
function developerFailsThenPasses(reason: string): PipelineAgentPlan {
  return {
    byRole: {
      developer: [
        { kind: "throw", message: reason },
        { kind: "throw", message: reason },
        { kind: "pass" },
      ],
    },
  };
}
function developerFails(reason: string): PipelineAgentPlan {
  return {
    byRole: {
      developer: [
        { kind: "throw", message: reason },
        { kind: "throw", message: reason },
      ],
    },
  };
}
function analystAsksTwiceThenPasses(
  firstLesson: string,
  secondLesson: string,
): PipelineAgentPlan {
  return {
    byRole: {
      analyst: [
        { kind: "needsHuman", lesson: firstLesson },
        { kind: "needsHuman", lesson: secondLesson },
        { kind: "pass" },
      ],
    },
  };
}
const summary = (text: string) => ({
  check: "gateSummary" as const,
  at: gateVisit("developer"),
  contains: text,
});
const questionSummary = (text: string, occurrence: number) => ({
  check: "gateSummary" as const,
  at: gateVisit("analyst", occurrence),
  contains: text,
});
test(
  "RG234-A: exhausted transient developer failure -> retry gate -> retry completes in the same run/worktree",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("RG234-A"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        agent: developerFailsThenPasses(
          "scripted developer crash: transport disconnected",
        ),
      },
      when: [
        chooseGate("planGate", "approved"),
        retryAgent("developer", "retry", "keep"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        summary("transient_retry"),
        summary("developer"),
        summary("attemptsExhausted"),
        expectEvent({ type: "runner_retry_exhausted" }),
        expectEvent({ type: "run_completed" }),
        forbidEvent("run_recovery_created"),
        expectEventPath([
          {
            type: "step_succeeded",
            where: { stepKey: "developer#2", attemptNo: 1 },
          },
        ]),
        { check: "roleCallCount", role: "developer", count: { exact: 3 } },
        { check: "roleCallCount", role: "analyst", count: { exact: 1 } },
        { check: "roleWorktree", role: "developer", equals: "run-worktree" },
      ],
    });
  },
);
test(
  "RG234-B: exhausted transient developer failure -> retry gate -> give_up preserves blocked behavior",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("RG234-B"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        agent: developerFails(
          "scripted developer crash: transport disconnected",
        ),
      },
      when: [
        chooseGate("planGate", "approved"),
        retryAgent("developer", "give_up"),
      ],
      then: [
        expectTerminal("blocked"),
        summary("transient_retry"),
        summary("developer"),
        summary("attemptsExhausted"),
        expectEvent({ type: "runner_retry_exhausted" }),
        expectEvent({ type: "pipeline_blocked" }),
        forbidEvent("run_completed"),
        forbidEvent("run_recovery_created"),
      ],
    });
  },
);
test(
  "RG234-C: 529 Overloaded is transient enough to reach the manual retry gate",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("RG234-C"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        agent: developerFails("provider 529 Overloaded; please retry later"),
      },
      when: [
        chooseGate("planGate", "approved"),
        retryAgent("developer", "give_up"),
      ],
      then: [
        expectTerminal("blocked"),
        summary("transient_retry"),
        summary("overloaded"),
        summary("529"),
        expectEvent({ type: "runner_retry_exhausted" }),
        expectEvent({ type: "pipeline_blocked" }),
      ],
    });
  },
);
test(
  "RG234-D: agent needsHuman question -> answer resumes the same run and reaches the retrying agent",
  { skip: e2eSkip },
  async () => {
    const providerAnswer = {
      provider: "oauth",
      reason: "use existing OAuth tenant",
    };
    const regionAnswer = {
      region: "eu",
      reason: "match customer data residency",
    };
    const first = "which auth provider should the feature use?";
    const second = "which region should the feature use?";
    await pipeline.execute({
      coverage: coverageForScenario("RG234-D-agent-question-resume"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        agent: analystAsksTwiceThenPasses(first, second),
      },
      when: [
        answerQuestion("analyst", providerAnswer),
        answerQuestion("analyst", regionAnswer),
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        questionSummary("analyst", 1),
        questionSummary(first, 1),
        questionSummary(second, 2),
        expectEvent({ type: "agent_question_opened" }),
        expectEvent({ type: "agent_question_resolved" }),
        expectEvent({ type: "run_completed" }),
        forbidEvent("pipeline_blocked"),
        forbidEvent("run_recovery_created"),
        { check: "roleCallCount", role: "analyst", count: { exact: 3 } },
        {
          check: "roleRetryContext",
          role: "analyst",
          callIndex: 1,
          equals: {
            kind: "agent_question",
            nodeId: "analyst",
            answer: providerAnswer,
            lesson: first,
            resolvedBy: "e2e",
          },
        },
        {
          check: "roleRetryContext",
          role: "analyst",
          callIndex: 2,
          equals: {
            kind: "agent_question",
            nodeId: "analyst",
            answer: regionAnswer,
            lesson: second,
            resolvedBy: "e2e",
          },
          distinctInboxFromCallIndex: 1,
        },
      ],
    });
  },
);
