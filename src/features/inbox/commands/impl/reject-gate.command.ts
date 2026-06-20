export type RejectGateCommandData = {
  inboxId: string;
  resolvedBy?: string;
};

export class RejectGateCommand {
  constructor(readonly data: RejectGateCommandData) {}
}
