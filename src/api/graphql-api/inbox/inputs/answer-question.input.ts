import { Field, ID, InputType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class AnswerQuestionInput {
  @Field(() => ID)
  inboxId!: string;

  @Field(() => GraphQLJSON)
  answer!: unknown;

  @Field(() => String, { nullable: true })
  resolvedBy?: string;
}
