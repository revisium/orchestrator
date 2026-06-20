import { Field, InputType, Int } from '@nestjs/graphql';

@InputType()
export class ConnectionInput {
  @Field(() => Int, { defaultValue: 50 })
  first!: number;

  @Field(() => String, { nullable: true })
  after?: string;
}
