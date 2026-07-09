import { Field, InputType } from '@nestjs/graphql';
import { ConnectionInput } from '../../share/inputs/connection.input.js';

@InputType()
export class ListRunProfilesInput extends ConnectionInput {
  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String, { nullable: true })
  pipelineId?: string;

  @Field(() => Boolean, { nullable: true })
  includeDeprecated?: boolean;
}
