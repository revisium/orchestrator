import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class ProjectModel {
  @Field(() => String)
  org!: string;

  @Field(() => String)
  project!: string;

  @Field(() => String)
  branch!: string;

  @Field(() => String)
  dataDir!: string;
}
