export type ResolveInboxItemCommandData = {
  inboxId: string;
  answer: unknown;
  resolvedBy?: string;
  signalGate?: boolean;
};

export class ResolveInboxItemCommand {
  constructor(readonly data: ResolveInboxItemCommandData) {}
}
