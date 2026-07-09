import { Field, InputType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class ValidateRunProfileInput {
  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => GraphQLJSON)
  profile!: unknown;
}
