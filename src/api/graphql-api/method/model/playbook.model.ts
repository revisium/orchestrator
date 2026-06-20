import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class PlaybookModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  packageName!: string;

  @Field(() => String)
  version!: string;

  @Field(() => String)
  source!: string;

  @Field(() => Int)
  schemaVersion!: number;
}
