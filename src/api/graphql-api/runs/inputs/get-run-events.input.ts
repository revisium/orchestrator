import { Field, ID, InputType } from '@nestjs/graphql';
import { ConnectionInput } from '../../share/inputs/connection.input.js';

@InputType()
export class GetRunEventsInput extends ConnectionInput {
  @Field(() => ID)
  runId!: string;

  @Field(() => String, { nullable: true })
  type?: string;
}
