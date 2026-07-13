import assert from "node:assert/strict";
import test from "node:test";
import {
  EventObservationSession,
  type EventObservationClock,
  type ObservedRunEvent,
} from "./pipeline-case-evidence.js";
import type { PipelineExpectation } from "./pipeline-case.js";

function event(type: string, payload: unknown = {}): ObservedRunEvent {
  return { type, payload } as ObservedRunEvent;
}

function session(
  snapshots: readonly (readonly ObservedRunEvent[])[],
  sleeps: number[] = [],
) {
  let reads = 0;
  const api = {
    async getRunEvents() {
      const snapshot = snapshots[Math.min(reads++, snapshots.length - 1)];
      return snapshot;
    },
  };
  const clock: EventObservationClock = {
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
    },
  };
  return { api, clock, reads: () => reads };
}

test("coalesces immediate positive, path, and forbidden requirements into eleven reads", async () => {
  const positive = [
    event("step_succeeded", { role: "developer" }),
    event("run_completed"),
  ];
  const fake = session([positive]);
  const expectations: PipelineExpectation[] = [
    { check: "event", event: { type: "run_completed" } },
    {
      check: "eventPath",
      events: [{ type: "step_succeeded" }, { type: "run_completed" }],
    },
    { check: "forbiddenEvent", type: "pipeline_blocked" },
    { check: "forbiddenEvent", type: "run_failed" },
  ];

  await new EventObservationSession(
    fake.api as never,
    "run-1",
    fake.clock,
  ).collect(expectations);
  assert.equal(fake.reads(), 11);
});

test("uses one complete initial snapshot for role ordering and redaction", async () => {
  const fake = session([
    [
      event("pipeline_fork"),
      event("step_succeeded", { role: "reviewer" }),
      event("step_succeeded", { role: "developer" }),
    ],
  ]);
  await new EventObservationSession(
    fake.api as never,
    "run-1",
    fake.clock,
  ).collect([
    { check: "roleAfterEvent", role: "developer", event: "pipeline_fork" },
    { check: "persistedEvents", excludes: "secret-token" },
  ]);
  assert.equal(fake.reads(), 1);
});

test("accepts a role step after the target even when that role ran before it", async () => {
  const fake = session([
    [
      event("step_succeeded", { role: "developer" }),
      event("pipeline_fork"),
      event("step_succeeded", { role: "developer" }),
    ],
  ]);
  await new EventObservationSession(
    fake.api as never,
    "run-1",
    fake.clock,
  ).collect([{ check: "roleAfterEvent", role: "developer", event: "pipeline_fork" }]);
  assert.equal(fake.reads(), 1);
});

test("rejects role evidence when no matching step follows the target event", async () => {
  const fake = session([
    [
      event("step_succeeded", { role: "developer" }),
      event("pipeline_fork"),
    ],
  ]);
  await assert.rejects(
    () =>
      new EventObservationSession(fake.api as never, "run-1", fake.clock).collect([
        { check: "roleAfterEvent", role: "developer", event: "pipeline_fork" },
      ]),
    /required pipeline event evidence was not observed/,
  );
});

test("refreshes one shared positive loop and checks the final snapshot", async () => {
  const fake = session([
    [],
    [
      event("pipeline_blocked", {
        reason: "poll-pr",
        nodeId: "mergeApproveReverify",
      }),
    ],
  ]);
  const sleeps: number[] = [];
  const clock: EventObservationClock = {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  };
  await new EventObservationSession(fake.api as never, "run-1", clock).collect([
    {
      check: "event",
      event: {
        type: "pipeline_blocked",
        where: { reason: "poll-pr", nodeId: "mergeApproveReverify" },
      },
    },
  ]);
  assert.equal(fake.reads(), 2);
  assert.deepEqual(sleeps, [250]);
});

test("requires blocked reason and lesson on the same event", async () => {
  const fake = session([
    [
      event("pipeline_blocked", { reason: "blocked", lesson: "wrong" }),
      event("pipeline_blocked", { reason: "other", lesson: "expected lesson" }),
    ],
  ]);
  await assert.rejects(
    () =>
      new EventObservationSession(
        fake.api as never,
        "run-1",
        fake.clock,
      ).collect([
        {
          check: "blockedDecision",
          reason: "blocked",
          lessonContains: ["expected lesson"],
        },
      ]),
    /required pipeline event evidence was not observed/,
  );
});

test("does not read events when expectations are not event-backed", async () => {
  const fake = session([[]]);
  await new EventObservationSession(
    fake.api as never,
    "run-1",
    fake.clock,
  ).collect([
    { check: "terminal", equals: "completed" },
    { check: "engine", equals: "data-driven" },
  ]);
  assert.equal(fake.reads(), 0);
});

test("descriptor multiplication preserves the shared observation budget", async () => {
  const fake = session([[event("run_completed")]]);
  const expectations: PipelineExpectation[] = [
    ...Array.from(
      { length: 5 },
      () =>
        ({
          check: "event",
          event: { type: "run_completed" as const },
        }) as const,
    ),
    ...Array.from(
      { length: 5 },
      () =>
        ({
          check: "forbiddenEvent",
          type: "pipeline_blocked" as const,
        }) as const,
    ),
  ];
  await new EventObservationSession(
    fake.api as never,
    "run-1",
    fake.clock,
  ).collect(expectations);
  assert.equal(fake.reads(), 11);
});

test("checks every refreshed forbidden snapshot, including the tenth", async () => {
  const snapshots: ObservedRunEvent[][] = [
    [event("run_completed")],
    ...Array.from({ length: 9 }, () => [event("run_completed")]),
    [event("pipeline_blocked")],
  ];
  const fake = session(snapshots);
  await assert.rejects(
    () =>
      new EventObservationSession(
        fake.api as never,
        "run-1",
        fake.clock,
      ).collect([{ check: "forbiddenEvent", type: "pipeline_blocked" }]),
    /forbidden pipeline event observed/,
  );
  assert.equal(fake.reads(), 11);
});

test("redaction uses the complete 500-row snapshot and detects a secret", async () => {
  const events = Array.from({ length: 500 }, (_, index) =>
    event("step_succeeded", {
      index,
      value: index === 499 ? "secret-token" : "safe",
    }),
  );
  const fake = session([events]);
  await assert.rejects(
    () =>
      new EventObservationSession(
        fake.api as never,
        "run-1",
        fake.clock,
      ).collect([{ check: "persistedEvents", excludes: "secret-token" }]),
    /persisted event snapshot/,
  );
  assert.equal(fake.reads(), 1);
});
