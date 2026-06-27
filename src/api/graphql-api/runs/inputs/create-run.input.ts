import { Field, InputType, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class CreateRunInput {
  @Field(() => String)
  title!: string;

  @Field(() => String)
  repo!: string;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => String, { nullable: true })
  scope?: string;

  @Field(() => Int, { nullable: true })
  priority?: number;

  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String, { nullable: true })
  pipelineId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  params?: unknown;

  @Field(() => GraphQLJSON, { nullable: true })
  issueRef?: unknown;

  @Field(() => Boolean, { defaultValue: false })
  start?: boolean;
}
