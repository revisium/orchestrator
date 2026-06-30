export type ResolveGateCommandData = {
  inboxId: string;
  outcome: string;
  resolvedBy?: string;
};

export class ResolveGateCommand {
  constructor(readonly data: ResolveGateCommandData) {}
}
