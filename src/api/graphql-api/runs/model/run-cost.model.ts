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
  runnerId!: string;

  @Field(() => String)
  provider!: string;

  @Field(() => String)
  modelId!: string;

  @Field(() => Int, { nullable: true })
  inputTokens!: number | null;

  @Field(() => Int, { nullable: true })
  outputTokens!: number | null;

  @Field(() => Float, { nullable: true })
  costAmount!: number | null;

  @Field(() => String, { nullable: true })
  currency!: string | null;

  @Field(() => Date)
  recordedAt!: Date;
}
