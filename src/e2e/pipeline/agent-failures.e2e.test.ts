import { before, after, test } from "node:test";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import {
  chooseGate,
  expectEvent,
  expectTerminal,
  forbidEvent,
  retryAgent,
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

test(
  "C1: a blocking review triggers rework, then the run completes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("C1"),
      given: {
        repo: pipeline.target(),
        profile: "fixture-agent",
        agent: {
          byRole: {
            reviewer: [
              { kind: "pass" },
              { kind: "verdict", verdict: "blocker" },
              { kind: "pass" },
            ],
          },
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        { check: "roleCallCount", role: "developer", count: { minimum: 2 } },
      ],
    });
  },
);
test(
  "C2: a review that never passes blocks the pipeline at the iteration cap",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("C2"),
      given: {
        repo: pipeline.target(),
        profile: "fixture-agent",
        agent: {
          byRole: { reviewer: { kind: "verdict", verdict: "blocker" } },
        },
      },
      when: [chooseGate("planGate", "approved")],
      then: [
        expectTerminal("blocked"),
        expectEvent({ type: "pipeline_blocked" }),
      ],
    });
  },
);
test(
  "C3: a developer that throws reaches the retry gate and does not complete after give_up",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("C3"),
      given: {
        repo: pipeline.target(),
        profile: "fixture-agent",
        agent: {
          byRole: {
            developer: { kind: "throw", message: "scripted developer crash" },
          },
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        retryAgent("developer", "give_up"),
      ],
      then: [
        expectTerminal("blocked"),
        expectEvent({ type: "runner_retry_exhausted" }),
        expectEvent({ type: "pipeline_blocked" }),
        forbidEvent("run_completed"),
      ],
    });
  },
);
test(
  "C4: markdown output without top-level verdict terminal-fails as invalid result",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("C4"),
      given: {
        repo: pipeline.target(),
        profile: "fixture-agent",
        agent: {
          byRole: {
            reviewer: {
              kind: "invalidNoVerdict",
              output: "# Review\napproved",
            },
          },
        },
      },
      when: [],
      then: [
        expectTerminal("failed"),
        expectEvent({ type: "step_failed" }),
        expectEvent({ type: "run_failed" }),
        { check: "failureReason", contains: ["revo.ResultInvalid"] },
      ],
    });
  },
);
