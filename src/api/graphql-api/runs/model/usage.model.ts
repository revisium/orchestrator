import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class UsageModel {
  @Field(() => Int, { nullable: true })
  inputTokens!: number | null;

  @Field(() => Int, { nullable: true })
  outputTokens!: number | null;

  @Field(() => Float, { nullable: true })
  costAmount!: number | null;
}
