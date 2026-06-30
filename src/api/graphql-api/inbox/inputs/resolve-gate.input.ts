import { Field, ID, InputType } from '@nestjs/graphql';
import type { ManualAdoptionAuditInput as DomainManualAdoptionAuditInput } from '../../../../control-plane/manual-adoption-audit.js';

@InputType()
export class ManualAdoptionAuditInput implements DomainManualAdoptionAuditInput {
  @Field(() => String)
  runId!: string;

  @Field(() => String)
  step!: string;

  @Field(() => String)
  role!: string;

  @Field(() => String)
  targetRepo!: string;

  @Field(() => String)
  targetBranch!: string;

  @Field(() => String)
  actor!: string;

  @Field(() => String)
  scope!: string;

  @Field(() => String)
  risk!: string;

  @Field(() => String)
  verificationResponsibility!: string;

  @Field(() => String, { nullable: true })
  artifactRef?: string;

  @Field(() => String, { nullable: true })
  worktreeRef?: string;
}

@InputType()
export class ResolveGateInput {
  @Field(() => ID)
  inboxId!: string;

  @Field(() => String)
  outcome!: string;

  @Field(() => String, { nullable: true })
  note?: string;

  @Field(() => String, { nullable: true })
  resolvedBy?: string;

  @Field(() => ManualAdoptionAuditInput, { nullable: true })
  adoptionAudit?: ManualAdoptionAuditInput;
}
