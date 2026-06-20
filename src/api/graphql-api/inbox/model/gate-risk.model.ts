import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class GateRiskModel {
  @Field(() => ID)
  inboxId!: string;

  @Field(() => String)
  kind!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String, { nullable: true })
  topic!: string | null;

  @Field(() => String)
  risk!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  context!: unknown;

  @Field(() => GraphQLJSON, { nullable: true })
  options!: unknown;
}
