import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RunCostModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  runId!: string;

  @Field(() => String)
  stepId!: string;

  @Field(() => String)
  attemptId!: string;

  @Field(() => String)
  modelProfile!: string;

  @Field(() => Int)
  inputTokens!: number;

  @Field(() => Int)
  outputTokens!: number;

  @Field(() => Float)
  costAmount!: number;

  @Field(() => String)
  currency!: string;

  @Field(() => Date)
  recordedAt!: Date;
}
