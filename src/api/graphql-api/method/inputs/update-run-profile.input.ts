import { Field, InputType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { RunProfileStatus } from '../model/run-profile-status.model.js';

@InputType()
export class UpdateRunProfileInput {
  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => String)
  profileId!: string;

  @Field(() => String)
  expectedProfileHash!: string;

  @Field(() => String, { nullable: true })
  displayName?: string;

  @Field(() => String, { nullable: true })
  summary?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  profile?: unknown;

  @Field(() => RunProfileStatus, { nullable: true })
  status?: RunProfileStatus;
}
