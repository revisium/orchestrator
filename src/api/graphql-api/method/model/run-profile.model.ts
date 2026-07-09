import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { RunProfileStatus } from './run-profile-status.model.js';

@ObjectType()
export class RunProfileModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  playbookId!: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => String)
  profileId!: string;

  @Field(() => String)
  schemaVersion!: string;

  @Field(() => String)
  version!: string;

  @Field(() => String)
  displayName!: string;

  @Field(() => String)
  summary!: string;

  @Field(() => GraphQLJSON)
  profile!: unknown;

  @Field(() => String)
  profileHash!: string;

  @Field(() => RunProfileStatus)
  status!: RunProfileStatus;
}
