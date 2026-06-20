import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RunModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  title!: string;

  @Field(() => String)
  status!: string;

  @Field(() => Int)
  priority!: number;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => String, { nullable: true })
  scope?: string;

  @Field(() => [String])
  repos!: string[];

  @Field(() => Date)
  createdAt!: Date;
}
