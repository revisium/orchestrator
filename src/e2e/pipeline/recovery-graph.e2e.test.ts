import { before, after, test } from "node:test";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import {
  createPipelineContext,
  type PipelineContext,
  type PipelineTarget,
} from "../support/pipeline-context.js";
import { coverageForScenario } from "../../testing/policy/pipeline-coverage.js";
import {
  chooseGate,
  expectEventPath,
  expectTerminal,
  forbidEvent,
  forbidSideEffect,
  overrideMerge,
} from "../support/pipeline-case.js";

let pipeline: PipelineContext;
let target: PipelineTarget;
before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
  target = pipeline.target();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test(
  "RG-A: mergeGate approve -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-A-merge-approved"),
      given: {
        playbook: "default",
        repo: target,
        profile: "default-full",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEventPath([{ type: "merge_confirmed" }]),
      ],
    });
  },
);

test(
  "RG-B: mergeGate cancel -> cancelledEnd -> cancelled",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-B-merge-cancel"),
      given: {
        playbook: "default",
        repo: target,
        profile: "default-full",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "cancel"),
      ],
      then: [expectTerminal("cancelled")],
    });
  },
);

test(
  "RG-C: mergeGate override_merge over advisory thread -> confirmMerge -> completed",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-C-merge-override"),
      given: {
        playbook: "default",
        repo: target,
        profile: "default-full",
        github: "force-advisory-thread",
      },
      when: [
        chooseGate("planGate", "approved"),
        overrideMerge("e2e override: reviewed and accepting the open thread", {
          threadIds: ["PRRT_T1"],
          actor: "e2e",
          reason: "e2e override: reviewed and accepting the open thread",
          risk: "low: synthetic stub run, no real merge side effects",
          verificationResponsibility: "e2e harness",
          headSha: "deadbeefcafe",
        }),
      ],
      then: [
        expectTerminal("completed"),
        expectEventPath([
          { type: "merge_overridden" },
          { type: "merge_confirmed" },
        ]),
      ],
    });
  },
);

test(
  "RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-D-merge-recheck-clean"),
      given: {
        playbook: "default",
        repo: target,
        profile: "default-full",
      },
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
  "RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-E-ci-loop-recovery"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "always-ci-red",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        expectEventPath([
          { type: "pr_polled", where: { verdict: "ci_changes" } },
        ]),
        forbidEvent("merge_confirmed"),
      ],
    });
  },
);

test(
  "RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-F-unknown-then-clean"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "merge-unknown-then-clean",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEventPath([
          { type: "pr_polled", where: { verdict: "recheck" } },
          { type: "merge_confirmed" },
        ]),
      ],
    });
  },
);

test(
  "RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: coverageForScenario("RG-G-stale-reverify-recovery"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "merge-stale-at-reverify",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        forbidEvent("merge_confirmed"),
        expectEventPath([
          {
            type: "pipeline_blocked",
            where: { reason: "poll-pr", nodeId: "mergeApproveReverify" },
          },
        ]),
        { check: "nodeCalled", node: "classifyRecovery" },
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
