import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class InboxItemModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  kind!: string;

  @Field(() => String, { nullable: true })
  runId!: string | null;

  @Field(() => String, { nullable: true })
  taskId!: string | null;

  @Field(() => String, { nullable: true })
  stepId!: string | null;

  @Field(() => String, { nullable: true })
  projectId!: string | null;

  @Field(() => String)
  title!: string;

  @Field(() => String)
  status!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  context!: unknown;

  @Field(() => GraphQLJSON, { nullable: true })
  options!: unknown;

  @Field(() => GraphQLJSON, { nullable: true })
  answer!: unknown;

  @Field(() => String, { nullable: true })
  resolvedBy!: string | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date, { nullable: true })
  resolvedAt!: Date | null;
}
