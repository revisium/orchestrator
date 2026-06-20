import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class InboxResolutionModel {
  @Field(() => ID)
  inboxId!: string;

  @Field(() => String)
  previousStatus!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  answer!: unknown;

  @Field(() => Boolean)
  signaled!: boolean;

  @Field(() => String, { nullable: true })
  topic!: string | null;

  @Field(() => String, { nullable: true })
  runId!: string | null;
}
