export type ApproveGateCommandData = {
  inboxId: string;
  resolvedBy?: string;
};

export class ApproveGateCommand {
  constructor(readonly data: ApproveGateCommandData) {}
}
