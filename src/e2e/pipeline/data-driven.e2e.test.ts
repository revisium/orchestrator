import { after, before, test } from "node:test";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import {
  chooseGate,
  expectEvent,
  expectTerminal,
} from "../support/pipeline-case.js";
import {
  createPipelineContext,
  type PipelineAgentPlan,
  type PipelineContext,
  type PipelineTarget,
} from "../support/pipeline-context.js";
let pipeline: PipelineContext;
let target: PipelineTarget;
const cleanWatcher: PipelineAgentPlan = {
  byRole: { watcher: { kind: "domainVerdict", verdict: "clean" } },
};
before(async () => {
  if (RUN_REAL_E2E) {
    pipeline = await createPipelineContext();
    target = pipeline.target();
  }
});
after(async () => {
  if (pipeline) await pipeline.close();
});
test(
  "L1: a data-driven run drives plan and merge gates to completion",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("L1"),
      given: {
        repo: target,
        pipelineId: "feature-development-dd",
        profile: "fixture-full",
        agent: cleanWatcher,
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        { check: "engine", equals: "data-driven" },
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "run_completed" }),
        ...["analyst", "developer", "reviewer", "watcher"].map((role) => ({
          check: "roleCalled" as const,
          role,
        })),
      ],
    });
  },
);
test(
  "L4: a produced plan is hydrated into the consuming developer context",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("L4"),
      given: {
        repo: target,
        pipelineId: "feature-development-dd",
        profile: "fixture-full",
        agent: cleanWatcher,
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        {
          check: "roleContext",
          role: "developer",
          contains: "## Inputs (from previous steps)",
        },
        {
          check: "roleContext",
          role: "developer",
          contains: '"role": "analyst"',
        },
      ],
    });
  },
);
test(
  "L3: reviewer blockers exhaust the data-declared cap and abort at the stuck gate",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("L3"),
      given: {
        repo: target,
        pipelineId: "feature-development-dd",
        profile: "fixture-full",
        agent: {
          byRole: {
            reviewer: { kind: "verdict", verdict: "blocker" },
            watcher: { kind: "domainVerdict", verdict: "clean" },
          },
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("codeStuckGate", "abort"),
      ],
      then: [
        expectTerminal("blocked"),
        expectEvent({ type: "pipeline_blocked" }),
        { check: "roleCallCount", role: "developer", count: { minimum: 2 } },
      ],
    });
  },
);
