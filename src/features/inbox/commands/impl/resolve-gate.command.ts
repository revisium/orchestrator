import type { ManualAdoptionAuditInput } from '../../../../control-plane/manual-adoption-audit.js';

export type ResolveGateCommandData = {
  inboxId: string;
  outcome: string;
  note?: string;
  resolvedBy?: string;
  adoptionAudit?: ManualAdoptionAuditInput;
};

export class ResolveGateCommand {
  constructor(readonly data: ResolveGateCommandData) {}
}
