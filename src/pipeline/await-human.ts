

















import { fnv1a64Hex } from '../control-plane/steps.js';
import type { NewInboxItem } from '../control-plane/inbox.js';
import type { AppendEventInput } from '../run/append-event.js';


type DecisionMeta = {
  answer?: unknown;
  note?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  inboxId?: string;
};

export type Decision =
  | ({ decision: 'approve' | 'reject'; outcome?: string } & DecisionMeta)
  | ({ outcome: string; decision?: 'approve' | 'reject' } & DecisionMeta);


export type AwaitHumanDeps = {


  pushInbox: (item: NewInboxItem, id: string) => Promise<string>;


  awaitDecision: <T>(topic: string) => Promise<T | null>;

  appendEvent: (input: AppendEventInput) => Promise<void>;
};


function cleanOptions(input: readonly string[] | undefined): string[] {
  return (input ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}




export function makeAwaitHuman(deps: AwaitHumanDeps) {
  const { pushInbox, awaitDecision, appendEvent } = deps;

  return async function awaitHumanImpl(
    runId: string,
    topic: 'plan' | 'merge' | 'question',
    gateKey: string,
    title: string,
    summary: unknown,
    options?: string[],
  ): Promise<Decision> {
    const inboxKey = `${runId}|${gateKey}`;
    const inboxId = `inbox_${fnv1a64Hex(inboxKey)}`;
    const outcomes = summary && typeof summary === 'object' && 'outcomes' in summary && Array.isArray(summary.outcomes)
      ? cleanOptions(summary.outcomes.filter((item): item is string => typeof item === 'string'))
      : [];
    const explicitOptions = cleanOptions(options);
    const gateOptions = explicitOptions.length > 0 ? explicitOptions : outcomes.length > 0 ? outcomes : ['approve', 'reject'];

    await pushInbox(
      {
        kind: 'approval',
        runId,
        title,
        context: { topic, summary },
        options: gateOptions,
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

    return msg ?? { decision: 'reject', answer: { reason: 'gate-timeout' }, inboxId };
  };
}
