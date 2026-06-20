import { Field, ID, InputType, Int } from '@nestjs/graphql';

@InputType()
export class GetRunAttemptsInput {
  @Field(() => ID)
  runId!: string;

  @Field(() => Int, { defaultValue: 50 })
  first!: number;

  @Field(() => String, { nullable: true })
  after?: string;
}
