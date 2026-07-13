import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import { expectEvent, expectTerminal } from "../support/pipeline-case.js";
import {
  createPipelineContext,
  type PipelineContext,
  type PipelineTarget,
  type PipelineAgentPlan,
} from "../support/pipeline-context.js";
const PLAYBOOK_ID = "revisium-agent-playbook-parallel-e2e";
const PIPELINE_ID = "parallel-review-consensus-e2e";
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
const consensus = (verdicts: string[], attemptVerdicts?: string[]) => ({
  check: "reviewerConsensus" as const,
  nodeIds: ["primaryReview", "secondaryReview"],
  verdicts,
  ...(attemptVerdicts
    ? { attemptVerdicts, processArtifacts: "required" as const }
    : {}),
});
type ReviewerPlan = Exclude<
  NonNullable<PipelineAgentPlan["byRole"]>[string],
  readonly unknown[]
>;
const given = (reviewer: readonly ReviewerPlan[]) => ({
  repo: target,
  playbookId: PLAYBOOK_ID,
  pipelineId: PIPELINE_ID,
  profile: "fixture-agent" as const,
  agent: { byRole: { reviewer } },
});
test(
  "N1: both approved reviewer branches arrive before the all-join completes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("N1"),
      given: given([
        { kind: "domainVerdict", verdict: "approved" },
        { kind: "domainVerdict", verdict: "approved" },
      ]),
      when: [],
      then: [
        expectTerminal("completed"),
        { check: "engine", equals: "data-driven" },
        expectEvent({ type: "pipeline_fork" }),
        expectEvent({ type: "run_completed" }),
        { check: "roleCallCount", role: "reviewer", count: { exact: 2 } },
        consensus(["approved", "approved"], ["approved", "approved"]),
      ],
    });
  },
);

test(
  "observability: parallel attempts are discoverable through the public run view",
  { skip: e2eSkip },
  async () => {
    const firstMarker = "PARALLEL-OBSERVABILITY-FIRST";
    const secondMarker = "PARALLEL-OBSERVABILITY-SECOND";
    pipeline.armAgentOutputFirstWriteBarrier(2);
    const runId = await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("N1"),
      given: {
        ...given([
          { kind: "reporter", marker: firstMarker },
          { kind: "reporter", marker: secondMarker },
        ]),
      },
      when: [],
      then: [
        expectTerminal("completed"),
        { check: "roleCallCount", role: "reviewer", count: { exact: 2 } },
        consensus(["approved", "approved"], ["approved", "approved"]),
      ],
    });

    const firstPage = await pipeline.readAgentOutputEvents({ runId, limit: 1 });
    assert.equal(firstPage.events.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await pipeline.readAgentOutputEvents({ runId, cursor: firstPage.nextCursor, limit: 100 });
    const events = [...firstPage.events, ...secondPage.events];
    const serialized = JSON.stringify(events);
    assert.match(serialized, new RegExp(firstMarker));
    assert.match(serialized, new RegExp(secondMarker));
    assert.equal(new Set(events.map((event) => event.attemptId)).size, 2);
    assert.equal(secondPage.cursorExpired, false);
  },
);
test(
  "N2: exactly one non-approved reviewer blocks consensus",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("N2"),
      given: given([
        { kind: "domainVerdict", verdict: "changes_requested" },
        { kind: "domainVerdict", verdict: "approved" },
      ]),
      when: [],
      then: [
        expectTerminal("blocked"),
        { check: "roleCallCount", role: "reviewer", count: { exact: 2 } },
        consensus(["changes_requested", "approved"]),
      ],
    });
  },
);
test(
  "N3: two non-approved reviewers both arrive before consensus blocks",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("N3"),
      given: given([
        { kind: "domainVerdict", verdict: "changes_requested" },
        { kind: "domainVerdict", verdict: "blocker" },
      ]),
      when: [],
      then: [
        expectTerminal("blocked"),
        { check: "roleCallCount", role: "reviewer", count: { exact: 2 } },
        consensus(["changes_requested", "blocker"]),
      ],
    });
  },
);
test(
  "N4: approved plus clean satisfies the consensus pass set",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("N4"),
      given: given([
        { kind: "domainVerdict", verdict: "approved" },
        { kind: "domainVerdict", verdict: "clean" },
      ]),
      when: [],
      then: [
        expectTerminal("completed"),
        { check: "roleCallCount", role: "reviewer", count: { exact: 2 } },
        consensus(["approved", "clean"]),
      ],
    });
  },
);
