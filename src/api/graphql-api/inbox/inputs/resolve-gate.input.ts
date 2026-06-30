import { Field, ID, InputType } from '@nestjs/graphql';

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
}
