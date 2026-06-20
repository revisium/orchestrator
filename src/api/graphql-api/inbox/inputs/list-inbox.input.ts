import { Field, InputType } from '@nestjs/graphql';
import { ConnectionInput } from '../../share/inputs/connection.input.js';

@InputType()
export class ListInboxInput extends ConnectionInput {
  @Field(() => String, { nullable: true })
  status?: string;

  @Field(() => String, { nullable: true })
  runId?: string;
}
