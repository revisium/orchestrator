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
  type PipelineContext,
  type PipelineTarget,
} from "../support/pipeline-context.js";
const PIPELINE = "feature-pr-watch";
const PIPELINE_POLL = "feature-pr-poll";
let pipeline: PipelineContext;
let target: PipelineTarget;
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
  "K1: a playbook-declared post-integrator role runs and completes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("K1"),
      given: {
        repo: target,
        pipelineId: PIPELINE,
        profile: "fixture-integrator",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "run_completed" }),
        { check: "roleCalled", role: "pr-watcher" },
        {
          check: "roleAfterEvent",
          role: "pr-watcher",
          event: "integrate_succeeded",
        },
      ],
    });
  },
);
test(
  "K2: the embedded role blocker verdict drives bounded rework to blocked",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("K2"),
      given: {
        repo: target,
        pipelineId: PIPELINE,
        profile: "fixture-integrator",
        agent: {
          byRole: { "pr-watcher": { kind: "verdict", verdict: "blocker" } },
        },
      },
      when: [chooseGate("planGate", "approved")],
      then: [
        expectTerminal("blocked"),
        expectEvent({ type: "pipeline_blocked" }),
        { check: "roleCalled", role: "pr-watcher" },
        { check: "roleCallCount", role: "developer", count: { minimum: 2 } },
      ],
    });
  },
);
test(
  "K4: an unknown-id post-integrator role runs and completes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("K4"),
      given: {
        repo: target,
        pipelineId: PIPELINE_POLL,
        profile: "fixture-integrator",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "run_completed" }),
        { check: "roleCalled", role: "pr-poller" },
        {
          check: "roleAfterEvent",
          role: "pr-poller",
          event: "integrate_succeeded",
        },
      ],
    });
  },
);
