import {
  chooseGate,
  gateVisit,
  overrideMerge,
  type PipelineCase,
  type PipelineExpectation,
} from "./pipeline-case.js";
import { nonDslPipelineCaseAttachment } from "../../testing/policy/non-dsl-ownership.js";

// These fixtures are compile-time contract proofs; none are executed.
const ambiguousPlaybook = {
  repo: "workspace",
  playbook: "default",
  playbookId: "other",
  // @ts-expect-error playbook and playbookId are mutually exclusive
} satisfies PipelineCase["given"];

const invalidRegisteredProfileGiven = {
  repo: "workspace",
  playbook: "default",
  // @ts-expect-error registered cases cannot select a fixture inline profile
  profile: "fixture-agent",
} satisfies Extract<PipelineCase["given"], { playbook: "default" }>;

// @ts-expect-error outcomes are correlated with the selected gate node
const wrongOutcome = chooseGate("planGate", "wontfix");

const incompatibleAudit = overrideMerge("override", {
  threadIds: ["thread-1"],
  actor: "human",
  reason: "reason",
  risk: "risk",
  verificationResponsibility: "owner",
  headSha: "sha",
  // @ts-expect-error audit has no fingerprint field
  fingerprint: "forbidden",
});

const incompatiblePresentation: PipelineExpectation = {
  check: "gateOptions",
  // @ts-expect-error gateOptions requires a planGate visit
  at: gateVisit("mergeGate"),
  equals: ["approved"],
};

const readonlyThen: PipelineCase = {
  coverage: nonDslPipelineCaseAttachment("B3"),
  given: { repo: "workspace" },
  when: [],
  then: [],
};
// @ts-expect-error then is readonly
readonlyThen.then.push({ check: "terminal", equals: "completed" });

void ambiguousPlaybook;
void invalidRegisteredProfileGiven;
void wrongOutcome;
void incompatibleAudit;
void incompatiblePresentation;
