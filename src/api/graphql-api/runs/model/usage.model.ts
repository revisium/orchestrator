import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class UsageModel {
  @Field(() => Int)
  inputTokens!: number;

  @Field(() => Int)
  outputTokens!: number;

  @Field(() => Float)
  costAmount!: number;
}
