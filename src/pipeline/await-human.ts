

















import { fnv1a64Hex } from '../control-plane/steps.js';
import type { InboxKind, NewInboxItem } from '../control-plane/inbox.js';
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
  | ({ outcome: string; decision?: 'approve' | 'reject' } & DecisionMeta)
  | ({ answer: unknown; decision?: 'approve' | 'reject'; outcome?: string } & DecisionMeta);

export type GateTopic = 'plan' | 'merge' | 'question' | 'retry';


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

function gateSignalTopic(runId: string, topic: GateTopic, gateKey: string): string {
  if (topic !== 'retry' && topic !== 'question') return topic;
  const signalKey = `${runId}|${gateKey}`;
  return `${topic}:${fnv1a64Hex(signalKey)}`;
}




export function makeAwaitHuman(deps: AwaitHumanDeps) {
  const { pushInbox, awaitDecision, appendEvent } = deps;

  return async function awaitHumanImpl(
    runId: string,
    topic: GateTopic,
    gateKey: string,
    title: string,
    summary: unknown,
    options?: string[],
    kind: Extract<InboxKind, 'approval' | 'question'> = 'approval',
  ): Promise<Decision> {
    const inboxKey = `${runId}|${gateKey}`;
    const inboxId = `inbox_${fnv1a64Hex(inboxKey)}`;
    const signalTopic = gateSignalTopic(runId, topic, gateKey);
    const outcomes = summary && typeof summary === 'object' && 'outcomes' in summary && Array.isArray(summary.outcomes)
      ? cleanOptions(summary.outcomes.filter((item): item is string => typeof item === 'string'))
      : [];
    const explicitOptions = cleanOptions(options);
    let gateOptions: string[];
    if (explicitOptions.length > 0) {
      gateOptions = explicitOptions;
    } else if (outcomes.length > 0) {
      gateOptions = outcomes;
    } else if (kind === 'question') {
      gateOptions = [];
    } else {
      gateOptions = ['approve', 'reject'];
    }

    await pushInbox(
      {
        kind,
        runId,
        title,
        context: { topic, ...(signalTopic !== topic ? { signalTopic } : {}), summary },
        options: gateOptions,
      },
      inboxId,
    );

    await appendEvent({
      runId,
      taskId: '',
      stepId: '',
      stepKey: kind === 'question' ? `question:${gateKey}` : `gate:${gateKey}`,
      type: kind === 'question' ? 'agent_question_opened' : 'gate_opened',
      payload: { topic, ...(signalTopic !== topic ? { signalTopic } : {}) },
    });

    const msg = await awaitDecision<Decision>(signalTopic);

    return msg ?? { decision: 'reject', answer: { reason: 'gate-timeout' }, inboxId };
  };
}
