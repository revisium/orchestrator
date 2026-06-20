import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class GateDecisionInput {
  @Field(() => ID)
  inboxId!: string;

  @Field(() => String, { nullable: true })
  resolvedBy?: string;
}
