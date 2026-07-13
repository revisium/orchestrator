import { after, test } from "node:test";
import { e2eSkip } from "../support/env.js";
import {
  createPipelineContext,
  type PipelineContext,
} from "../support/pipeline-context.js";
import { coverageForScenario } from "../../testing/policy/pipeline-coverage.js";
import {
  chooseGate,
  expectEvent,
  expectEventPath,
  expectSideEffect,
  expectTerminal,
  forbidEvent,
  forbidSideEffect,
  gateVisit,
  overrideMerge,
} from "../support/pipeline-case.js";
let pipeline: PipelineContext | undefined;
after(async () => {
  if (pipeline) await pipeline.close();
});
async function context(): Promise<PipelineContext> {
  pipeline ??= await createPipelineContext();
  return pipeline;
}
const summary = (node: "mergeGate" | "recoveryGate", text: string) => ({
  check: "gateSummary" as const,
  at: gateVisit(node),
  contains: text,
});
test(
  "#272: no registered checks are advisory and still reach mergeGate",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-272-no-checks-clean"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "no-checks-registered",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        summary("mergeGate", "checks: none registered"),
        forbidEvent("pipeline_blocked"),
        forbidEvent("merge_confirmed"),
        expectEventPath([{ type: "pr_polled", where: { verdict: "clean" } }]),
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-272-never-settling-recovery"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "checks-never-settle",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        forbidEvent("merge_confirmed"),
        expectEventPath([{ type: "pr_polled", where: { verdict: "recheck" } }]),
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#272: unclassifiable poll state routes through classifyRecovery to recoveryGate",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-272-unclassifiable-recovery"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "nonsense-poll-state",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        forbidEvent("merge_confirmed"),
        { check: "nodeCalled", node: "classifyRecovery" },
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#273: externally merged PR completes through cleanup without recovery or merge attempt",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-273-externally-merged"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "merged-externally",
      },
      when: [chooseGate("planGate", "approved")],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "run_completed" }),
        forbidEvent("pipeline_blocked"),
        forbidEvent("merge_confirmed"),
        expectEventPath([
          { type: "pr_polled", where: { verdict: "merged" } },
          { type: "worktree_released" },
        ]),
        expectSideEffect("list_open_pull_requests"),
        expectSideEffect("list_all_pull_requests"),
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-273-externally-closed"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "closed-externally",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        summary("recoveryGate", "pr_closed_externally"),
        forbidEvent("merge_confirmed"),
        expectEventPath([{ type: "pr_polled", where: { verdict: "closed" } }]),
        expectSideEffect("list_open_pull_requests"),
        expectSideEffect("list_all_pull_requests"),
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#274: head moved after merge approval re-presents mergeGate with fresh artifact",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-274-head-moved-reopens-merge-gate"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "head-moved-after-approve",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
        chooseGate("mergeGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        {
          check: "gateArtifactHead",
          at: gateVisit("mergeGate", 1),
          equals: "deadbeefcafe",
        },
        {
          check: "gateArtifactHead",
          at: gateVisit("mergeGate", 2),
          equals: "feedfacecafe",
        },
        forbidEvent("merge_confirmed"),
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#275: GraphQL partial outage routes to recovery instead of clean readiness",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-275-graphql-outage-recovery"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "empty-graphql-data",
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        forbidEvent("merge_confirmed"),
        expectEventPath([
          {
            type: "step_failed",
            where: {
              error:
                "invalid GraphQL shape in reviewThreads response: missing repository",
            },
          },
        ]),
        { check: "nodeCalled", node: "classifyRecovery" },
        forbidSideEffect("merge_pull_request"),
      ],
    });
  },
);
test(
  "#276: questionGate fix routes to review rework and resolves threads with the human reason",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    const note = "human chose fix because the review catches a real defect";
    await pipeline.execute({
      coverage: coverageForScenario("TC-276-question-fix"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "review-comment",
        agent: {
          byRole: { triager: { kind: "triage", decisions: ["question"] } },
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("questionGate", "fix", note),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "threads_responded" }),
        expectEvent({ type: "merge_confirmed" }),
        expectEventPath([
          { type: "pr_polled", where: { verdict: "review_changes" } },
          { type: "threads_responded" },
        ]),
        { check: "reviewReply", contains: note },
      ],
    });
  },
);
test(
  "#276: questionGate wontfix routes directly to respondThreads with the human reason",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    const note =
      "human chose wontfix because the requested change is out of scope";
    await pipeline.execute({
      coverage: coverageForScenario("TC-276-question-wontfix"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "review-comment",
        agent: {
          byRole: { triager: { kind: "triage", decisions: ["question"] } },
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("questionGate", "wontfix", note),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "threads_responded" }),
        expectEvent({ type: "merge_confirmed" }),
        expectEventPath([
          { type: "pr_polled", where: { verdict: "review_changes" } },
          { type: "threads_responded" },
        ]),
        { check: "reviewReply", contains: note },
      ],
    });
  },
);
test(
  "#277: cleanupWorktree dirty preserve after successful merge completes with cleanup_failed event",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    await pipeline.execute({
      coverage: coverageForScenario("TC-277-cleanup-dirty-preserve"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "happy",
        cleanup: { dirtyWorktreeBeforeRelease: true },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        forbidEvent("pipeline_blocked"),
        expectEventPath([
          { type: "merge_confirmed" },
          {
            type: "cleanup_failed",
            where: { reason: "dirty", released: false },
          },
          { type: "run_completed" },
        ]),
      ],
    });
  },
);
test(
  "#279: override_merge over advisory review threads replies, resolves, audits, and merges",
  { skip: e2eSkip },
  async () => {
    const pipeline = await context();
    const note = "force merge target contract: advisory review thread accepted";
    const risk = "synthetic e2e target contract";
    const verificationResponsibility = "e2e";
    await pipeline.execute({
      coverage: coverageForScenario("TC-279-override-advisory-thread"),
      given: {
        playbook: "default",
        repo: pipeline.target(),
        github: "force-advisory-thread",
      },
      when: [
        chooseGate("planGate", "approved"),
        overrideMerge(note, {
          threadIds: ["PRRT_T1"],
          actor: "e2e",
          reason: note,
          risk,
          verificationResponsibility,
          headSha: "deadbeefcafe",
        }),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "threads_responded" }),
        expectEvent({ type: "merge_overridden" }),
        expectEvent({ type: "merge_confirmed" }),
        expectEvent({ type: "run_completed" }),
        expectEventPath([
          {
            type: "merge_overridden",
            where: {
              actor: "e2e",
              note,
              reason: note,
              risk,
              verificationResponsibility,
              headSha: "deadbeefcafe",
              prNumber: 7,
            },
          },
        ]),
        {
          check: "reviewReply",
          contains: `merged by operator override: ${note}`,
        },
      ],
    });
  },
);
