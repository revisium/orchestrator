import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class CreateRunResultModel {
  @Field(() => ID)
  runId!: string;

  @Field(() => ID)
  taskId!: string;

  @Field(() => ID)
  eventId!: string;

  @Field(() => String)
  status!: string;

  @Field(() => Boolean)
  started!: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  route!: unknown;

  @Field(() => GraphQLJSON, { nullable: true })
  workflow!: unknown;
}
