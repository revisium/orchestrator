import { Field, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class RunProgressModel {
  @Field(() => String)
  workflowStatus!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  graphCursor!: unknown | null;

  @Field(() => Date)
  updatedAt!: Date;
}
