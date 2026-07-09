import { Field, InputType } from '@nestjs/graphql';

@InputType()
export class GetRunProfileInput {
  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => String)
  profileId!: string;
}
