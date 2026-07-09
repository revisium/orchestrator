import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class DeprecateRunProfileInput {
  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => String)
  profileId!: string;

  @Field(() => String)
  expectedProfileHash!: string;
}
