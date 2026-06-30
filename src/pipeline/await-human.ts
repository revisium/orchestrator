

















import { fnv1a64Hex } from '../control-plane/steps.js';
import type { NewInboxItem } from '../control-plane/inbox.js';
import type { AppendEventInput } from '../run/append-event.js';


export type Decision = {
  decision?: 'approve' | 'reject';
  outcome?: string;
  answer?: unknown;
  resolvedBy?: string;
};


export type AwaitHumanDeps = {


  pushInbox: (item: NewInboxItem, id: string) => Promise<string>;


  awaitDecision: <T>(topic: string) => Promise<T | null>;

  appendEvent: (input: AppendEventInput) => Promise<void>;
};





export function makeAwaitHuman(deps: AwaitHumanDeps) {
  const { pushInbox, awaitDecision, appendEvent } = deps;

  return async function awaitHumanImpl(
    runId: string,
    topic: 'plan' | 'merge' | 'question',
    gateKey: string,
    title: string,
    summary: unknown,
  ): Promise<Decision> {
    const inboxKey = `${runId}|${gateKey}`;
    const inboxId = `inbox_${fnv1a64Hex(inboxKey)}`;
    const outcomes = summary && typeof summary === 'object' && 'outcomes' in summary && Array.isArray(summary.outcomes)
      ? summary.outcomes.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];

    await pushInbox(
      {
        kind: 'approval',
        runId,
        title,
        context: { topic, summary },
        options: outcomes.length > 0 ? outcomes : ['approve', 'reject'],
      },
      inboxId,
    );

    await appendEvent({
      runId,
      taskId: '',
      stepId: '',
      stepKey: `gate:${gateKey}`,
      type: 'gate_opened',
      payload: { topic },
    });

    const msg = await awaitDecision<Decision>(topic);

    return msg ?? { decision: 'reject', answer: { reason: 'gate-timeout' } };
  };
}
