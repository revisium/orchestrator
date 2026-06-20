import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class RunEventModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  runId!: string;

  @Field(() => String)
  type!: string;

  @Field(() => String)
  actor!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => String)
  taskId!: string;

  @Field(() => String)
  stepId!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  payload!: unknown;
}
