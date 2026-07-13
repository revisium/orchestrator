import { after, before, test } from "node:test";
import { coverageForScenario } from "../../testing/policy/pipeline-coverage.js";
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
let pipeline: PipelineContext;
function target(): PipelineTarget {
  return pipeline.target();
}
before(async () => {
  if (RUN_REAL_E2E) pipeline = await createPipelineContext();
});
after(async () => {
  if (pipeline) await pipeline.close();
});
test(
  "M1b: shipped consensus disagreement reworks and then completes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("M1b-profile-consensus-rework"),
      given: {
        repo: target(),
        playbook: "default",
        profileId: "codex-gpt-5-6-luna-claude-opus-4-8-consensus",
        agent: {
          byRole: {
            reviewer: [
              { kind: "verdict", verdict: "changes_requested" },
              { kind: "pass" },
              { kind: "pass" },
              { kind: "pass" },
              { kind: "pass" },
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
        { check: "engine", equals: "data-driven" },
        expectEvent({ type: "pipeline_fork" }),
        expectEvent({ type: "run_completed" }),
        { check: "roleCallCount", role: "analyst", count: { exact: 2 } },
        { check: "roleCallCount", role: "reviewer", count: { exact: 6 } },
        { check: "roleCalled", role: "developer" },
      ],
    });
  },
);
test(
  "M1c: shipped exact single profile completes the single-review signature",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("M1-profile-single"),
      given: {
        repo: target(),
        playbook: "default",
        profileId: "codex-gpt-5-6-luna",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        { check: "engine", equals: "data-driven" },
        { check: "roleCallCount", role: "reviewer", count: { exact: 2 } },
      ],
    });
  },
);
test(
  "M2: shipped local-change profile completes without a gate",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("M2-profile-local-change"),
      given: {
        repo: target(),
        playbook: "default",
        pipelineId: "local-change",
        profileId: "local-change-codex-gpt-5-6-luna",
      },
      when: [],
      then: [
        expectTerminal("completed"),
        { check: "engine", equals: "data-driven" },
        { check: "roleCalled", role: "developer" },
        { check: "roleCallCount", role: "reviewer", count: { exact: 0 } },
      ],
    });
  },
);
test(
  "M3: shipped analysis-only profile completes without a gate",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("M3-profile-analysis-only"),
      given: {
        repo: target(),
        playbook: "default",
        pipelineId: "analysis-only",
        profileId: "analysis-only-codex-gpt-5-6-luna",
        developerWrite: false,
      },
      when: [],
      then: [
        expectTerminal("completed"),
        { check: "engine", equals: "data-driven" },
        { check: "roleCalled", role: "analyst" },
        { check: "roleCallCount", role: "developer", count: { exact: 0 } },
        { check: "roleCallCount", role: "reviewer", count: { exact: 0 } },
      ],
    });
  },
);
