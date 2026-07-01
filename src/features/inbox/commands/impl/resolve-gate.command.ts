import type { ManualAdoptionAuditInput } from '../../../../control-plane/manual-adoption-audit.js';
import type { MergeOverrideAuditInput } from '../../../../control-plane/merge-override-audit.js';

export type ResolveGateCommandData = {
  inboxId: string;
  outcome: string;
  note?: string;
  resolvedBy?: string;
  adoptionAudit?: ManualAdoptionAuditInput;
  mergeOverrideAudit?: MergeOverrideAuditInput;
};

export class ResolveGateCommand {
  constructor(readonly data: ResolveGateCommandData) {}
}
