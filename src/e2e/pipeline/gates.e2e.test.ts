import { after, before, test } from "node:test";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import {
  cancelRunAt,
  chooseGate,
  expectEventPath,
  expectTerminal,
  forbidEvent,
  gateVisit,
  rejectGate,
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
  "B3: plan-gate reject blocks the run and developer never executes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("B3"),
      given: { repo: pipeline.target() },
      when: [rejectGate("planGate")],
      then: [
        expectTerminal("blocked"),
        {
          check: "gateOptions",
          at: gateVisit("planGate"),
          equals: ["approved"],
        },
        forbidEvent("run_completed"),
        { check: "roleCallCount", role: "developer", count: { exact: 0 } },
      ],
    });
  },
);
test(
  "B4: merge-gate recheck re-polls readiness and re-presents the merge gate",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("B4"),
      given: { repo: pipeline.target() },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "recheck"),
        chooseGate("mergeGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        expectEventPath([{ type: "pr_polled", where: { verdict: "clean" } }]),
      ],
    });
  },
);
test(
  "B10: a parked gate exposes its pending decision and risk summary",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("B10"),
      given: { repo: pipeline.target() },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        {
          check: "pendingGateRisk",
          at: gateVisit("planGate"),
          equals: { topic: "plan", kind: "approval" },
        },
      ],
    });
  },
);
test(
  "B13: a parked plan gate carries the plan artifact and reviewer verdict",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("B13"),
      given: { repo: pipeline.target() },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        {
          check: "planGateArtifact",
          at: gateVisit("planGate"),
          source: { nodeId: "analyst", name: "plan" },
          content: "payload-or-preview",
          reviewerVerdict: "present",
        },
      ],
    });
  },
);
test(
  "B12: cancelling a run parked at a gate marks it cancelled",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("B12"),
      given: { repo: pipeline.target() },
      when: [cancelRunAt("planGate")],
      then: [expectTerminal("cancelled"), forbidEvent("run_completed")],
    });
  },
);
