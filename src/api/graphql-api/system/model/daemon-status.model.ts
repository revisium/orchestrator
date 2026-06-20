import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class DaemonStatusModel {
  @Field(() => Boolean)
  running!: boolean;

  @Field(() => Boolean)
  healthy!: boolean;

  @Field(() => Int, { nullable: true })
  pid!: number | null;

  @Field(() => String, { nullable: true })
  baseUrl!: string | null;

  @Field(() => Int, { nullable: true })
  httpPort!: number | null;

  @Field(() => Int, { nullable: true })
  pgPort!: number | null;
}
