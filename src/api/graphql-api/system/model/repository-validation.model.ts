import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RepositoryValidationModel {
  @Field(() => String)
  input!: string;

  @Field(() => String)
  path!: string;

  @Field(() => Boolean)
  exists!: boolean;

  @Field(() => Boolean)
  isDirectory!: boolean;

  @Field(() => String)
  gitRoot!: string;

  @Field(() => String)
  branch!: string;

  @Field(() => Boolean)
  clean!: boolean;

  @Field(() => String)
  remote!: string;

  @Field(() => String)
  error!: string;
}
