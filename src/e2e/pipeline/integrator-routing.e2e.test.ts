import { after, before, test } from "node:test";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";
import { RUN_REAL_E2E, e2eSkip } from "../support/env.js";
import {
  chooseGate,
  expectEvent,
  expectTerminal,
  forbidEvent,
  forbidSideEffect,
  gateVisit,
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
const summary = (text: string) => ({
  check: "gateSummary" as const,
  at: gateVisit("recoveryGate"),
  contains: text,
});
test(
  "D11: no produced change opens recovery and can cancel",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D11"),
      given: { repo: pipeline.target(), developerWrite: false },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [expectTerminal("cancelled"), forbidEvent("merge_confirmed")],
    });
  },
);
for (const row of [
  { caseId: "D9", github: "ambiguous-prs", summary: "Ambiguous:" },
  { caseId: "D10", github: "pr-view-non-json", summary: "JSON" },
] as const satisfies readonly {
  caseId: "D9" | "D10";
  github: "ambiguous-prs" | "pr-view-non-json";
  summary: string;
}[]) {
  test(
    `${row.caseId}: integration ambiguity routes to recovery`,
    { skip: e2eSkip },
    async () => {
      await pipeline.execute({
        coverage: nonDslPipelineCaseAttachment(row.caseId),
        given: { repo: pipeline.target(), github: row.github },
        when: [
          chooseGate("planGate", "approved"),
          chooseGate("recoveryGate", "cancel"),
        ],
        then: [
          expectTerminal("cancelled"),
          summary(row.summary),
          forbidEvent("merge_confirmed"),
        ],
      });
    },
  );
}
test(
  "D20 pipeline: confirm-merge refusal routes through recovery to cancellation",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D20"),
      given: { repo: pipeline.target(), github: "merge-not-clean" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "pipeline_blocked" }),
        forbidEvent("merge_confirmed"),
        {
          check: "blockedDecision",
          reason: "confirm-merge",
          lessonContains: ["mergeStateStatus=BLOCKED"],
        },
      ],
    });
  },
);
test(
  "D2: an existing open PR is reused without duplicate creation",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D2"),
      given: { repo: pipeline.target(), github: "pr-already-exists" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "run_completed" }),
        forbidSideEffect("create_pull_request"),
      ],
    });
  },
);
test(
  "D14: GitHub failure opens recovery with recheck and cancel outcomes",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D14"),
      given: { repo: pipeline.target(), github: "gh-error" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [expectTerminal("cancelled")],
    });
  },
);
test(
  "D14b: PR-ready failure exposes an actionable recovery lesson",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D14b"),
      given: { repo: pipeline.target(), github: "ready-fails" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        summary("failed to mark PR #7 ready for review"),
        summary("permission denied"),
      ],
    });
  },
);
test(
  "D7: unresolved pinned GitHub identity fails loud without ambient fallback",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D7"),
      given: {
        repo: pipeline.target(),
        integrator: {
          kind: "needsHuman",
          lesson:
            "could not resolve a token for the pinned gh account 'profile-bot'; REFUSING to fall back to the ambient gh account",
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        {
          check: "blockedDecision",
          reason: "integrate",
          lessonContains: ["REFUSING to fall back"],
        },
      ],
    });
  },
);
test(
  "D13: push rejection routes through recovery to cancellation",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D13"),
      given: {
        repo: pipeline.target(),
        integrator: {
          kind: "throw",
          message:
            "git push rejected: non-fast-forward (remote moved); integrate aborted",
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [expectTerminal("cancelled"), forbidEvent("run_completed")],
    });
  },
);
test(
  "D15: an integrator lesson token is redacted before persistence",
  { skip: e2eSkip },
  async () => {
    const rawToken = "gho_abcdEFGH1234567890LEAK";
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D15"),
      given: {
        repo: pipeline.target(),
        integrator: {
          kind: "needsHuman",
          lesson: `gh push failed: bad credentials using token ${rawToken} rejected by server`,
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        {
          check: "blockedDecision",
          reason: "integrate",
          lessonContains: ["[REDACTED]"],
        },
        { check: "persistedEvents", excludes: rawToken },
      ],
    });
  },
);
test(
  "D19: a token from a GitHub failure never reaches persisted events",
  { skip: e2eSkip },
  async () => {
    const rawToken = "gho_abcdEFGH1234567890LEAK";
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D19"),
      given: { repo: pipeline.target(), github: "gh-token-leak" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        { check: "persistedEvents", excludes: rawToken },
      ],
    });
  },
);
test(
  "D35: merge conflict reaches recovery with DIRTY merge-state evidence",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D35"),
      given: { repo: pipeline.target(), github: "merge-conflict" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("recoveryGate", "cancel"),
      ],
      then: [
        expectTerminal("cancelled"),
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "pipeline_blocked" }),
        {
          check: "blockedDecision",
          reason: "poll-pr",
          lessonContains: ["mergeStateStatus=DIRTY"],
        },
      ],
    });
  },
);
test(
  "D30: CI failure rework converges to green and merges",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D30"),
      given: { repo: pipeline.target(), github: "ci-red-then-green" },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "integrate_succeeded" }),
        expectEvent({ type: "pr_polled" }),
        expectEvent({ type: "merge_confirmed" }),
        expectEvent({ type: "run_completed" }),
      ],
    });
  },
);
for (const row of [
  { caseId: "D31", decision: "fix" },
  { caseId: "D32", decision: "wontfix" },
] as const satisfies readonly {
  caseId: "D31" | "D32";
  decision: "fix" | "wontfix";
}[]) {
  test(
    `${row.caseId}: review feedback is triaged, answered, and merged`,
    { skip: e2eSkip },
    async () => {
      await pipeline.execute({
        coverage: nonDslPipelineCaseAttachment(row.caseId),
        given: {
          repo: pipeline.target(),
          github: "review-comment",
          agent: {
            byRole: { triager: { kind: "triage", decisions: [row.decision] } },
          },
        },
        when: [
          chooseGate("planGate", "approved"),
          chooseGate("mergeGate", "approved"),
        ],
        then: [
          expectTerminal("completed"),
          expectEvent({ type: "pr_polled" }),
          expectEvent({ type: "threads_responded" }),
          expectEvent({ type: "merge_confirmed" }),
          expectEvent({ type: "run_completed" }),
        ],
      });
    },
  );
}
test(
  "D33: a human question decision resolves review feedback before merge",
  { skip: e2eSkip },
  async () => {
    await pipeline.execute({
      coverage: nonDslPipelineCaseAttachment("D33"),
      given: {
        repo: pipeline.target(),
        github: "review-comment",
        agent: {
          byRole: { triager: { kind: "triage", decisions: ["question"] } },
        },
      },
      when: [
        chooseGate("planGate", "approved"),
        chooseGate(
          "questionGate",
          "wontfix",
          "the requested rewrite is out of scope for this run",
        ),
        chooseGate("mergeGate", "approved"),
      ],
      then: [
        expectTerminal("completed"),
        expectEvent({ type: "pr_polled" }),
        expectEvent({ type: "threads_responded" }),
        expectEvent({ type: "merge_confirmed" }),
        expectEvent({ type: "run_completed" }),
      ],
    });
  },
);
