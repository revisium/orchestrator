import { Field, ID, InputType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import type { ManualAdoptionAuditInput } from '../../../../control-plane/manual-adoption-audit.js';

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

  @Field(() => GraphQLJSON, { nullable: true })
  adoptionAudit?: ManualAdoptionAuditInput;
}
