/**
 * await-human.ts — DBOS-free factory for the human-gate async function.
 *
 * INVARIANT: `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk` (M1 — DBOS sealed).
 * All DBOS interaction goes through injected deps: `awaitDecision` (wraps DBOS.recv)
 * and `appendEvent` (pure Revisium write).
 *
 * Gate mechanic (0004, §3.3):
 *  1. Write a deterministic inbox row (kind='approval', no stepId) via `pushInbox`.
 *     id = `inbox_${fnv1a64Hex(`${runId}|${topic}`)}` (22 chars ≤ 64, no timestamp).
 *     ROW_CONFLICT on replay → pushInbox returns the existing id (no-op, no throw).
 *  2. Emit a `gate_opened` observability event (deterministic id via appendEvent).
 *  3. DURABLY WAIT via `awaitDecision(topic)` → wraps DBOS.recv inside the workflow.
 *  4. null return from recv (far-future timeout) → fail-closed: treat as reject (E7).
 *
 * `recv` MUST run in the workflow body (not a registerStep). `pushInbox` and `appendEvent`
 * also run in the body; each is made idempotent independently (G1 / 0003 pattern).
 * The whole gate is `await`ed directly in the workflow body — no step wrapper needed.
 */

import { fnv1a64Hex } from '../control-plane/steps.js';
import type { NewInboxItem } from '../control-plane/inbox.js';
import type { AppendEventInput } from '../run/append-event.js';

/** The resolved human decision returned by awaitHuman. */
export type Decision = {
  decision: 'approve' | 'reject';
  answer?: unknown;
  resolvedBy?: string;
};

/** Dependencies injected into makeAwaitHuman — all DBOS-free typed. */
export type AwaitHumanDeps = {
  /**
   * Deterministic, idempotent inbox push (ROW_CONFLICT handled INSIDE the verb — §3.4a).
   * Wraps InboxService.pushInbox(item, { id }) with the verbatim deterministic id.
   */
  pushInbox: (item: NewInboxItem, id: string) => Promise<string>;
  /**
   * Durable human wait. Wraps DbosService.awaitDecision — which calls DBOS.recv inside
   * the registered workflow body. Returns null on timeout (far-future deadline).
   */
  awaitDecision: <T>(topic: string) => Promise<T | null>;
  /** Write an idempotent observability event (deterministic id + ROW_CONFLICT no-op). */
  appendEvent: (input: AppendEventInput) => Promise<void>;
};

/**
 * makeAwaitHuman — DBOS-free factory for the awaitHuman async function (C1 pattern).
 *
 * Returns a plain async function `await`ed directly inside the registered workflow body.
 * Tests import this builder directly (exercising the SAME production code) — no copy.
 */
export function makeAwaitHuman(deps: AwaitHumanDeps) {
  const { pushInbox, awaitDecision, appendEvent } = deps;

  return async function awaitHumanImpl(
    runId: string,
    topic: 'plan' | 'merge' | 'question',
    title: string,
    summary: unknown,
  ): Promise<Decision> {
    // 1. FULLY deterministic inbox id (no timestamp) so replay/restart never creates a duplicate row.
    //    fnv1a64Hex → 16 hex; `inbox_` + 16 = 22 chars ≤ 64 (mirrors append-event id derivation).
    const inboxKey = runId + '|' + topic;
    const inboxId = `inbox_${fnv1a64Hex(inboxKey)}`;

    // 2. Draft write: pending approval row. context carries the topic (OQ-2) so resolve can read it back.
    //    pushInbox catches ROW_CONFLICT internally and returns the same id (no-op on replay) — §3.4a.
    //    Gate rows carry NO stepId (gate is workflow-level, not a steps row — E9/E14).
    await pushInbox(
      {
        kind: 'approval',
        runId,
        title,
        context: { topic, summary },
        options: ['approve', 'reject'],
      },
      inboxId,
    );

    // 3. Observability event — already idempotent (deterministic event id + ROW_CONFLICT no-op, append-event.ts).
    //    Empty taskId/stepId is the established gate/pipeline-level convention (E14 — mirrors pipeline_blocked).
    await appendEvent({
      runId,
      taskId: '',
      stepId: '',
      stepKey: `gate:${topic}`,
      type: 'gate_opened',
      payload: { topic },
    });

    // 4. DURABLE WAIT on the topic keyed by this workflow's id (= runId).
    //    recv is called inside the workflow body via the injected dep (DBOS-sealed).
    const msg = await awaitDecision<Decision>(topic);

    // 5. recv null ⇒ timeout (only on the far-future GATE_DEADLINE_EPOCH_MS — treat as reject/fail-closed).
    //    See E7 in TASK.md.
    return msg ?? { decision: 'reject', answer: { reason: 'gate-timeout' } };
  };
}
