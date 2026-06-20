import { Field, ID, InputType } from '@nestjs/graphql';

@InputType()
export class RunSubscriptionInput {
  @Field(() => ID, { nullable: true })
  runId?: string;
}
