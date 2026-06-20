import { Field, ID, InputType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class ResolveInboxItemInput {
  @Field(() => ID)
  inboxId!: string;

  @Field(() => GraphQLJSON)
  answer!: unknown;

  @Field(() => String, { nullable: true })
  resolvedBy?: string;

  @Field(() => Boolean, { defaultValue: true })
  signalGate?: boolean;
}
