import { Field, InputType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { ExecutionProfileInput } from './execution-profile.input.js';

@InputType()
export class SimulateRouteInput {
  @Field(() => String)
  title!: string;

  @Field(() => String, { nullable: true })
  repo?: string;

  @Field(() => String, { nullable: true })
  pipeline?: string;

  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  params?: unknown;

  @Field(() => ExecutionProfileInput, { nullable: true })
  executionProfile?: ExecutionProfileInput;
}
