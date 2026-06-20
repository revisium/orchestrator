import { Field, ObjectType } from '@nestjs/graphql';
import { RepositoryValidationModel } from './repository-validation.model.js';

@ObjectType()
export class RepositoryGuidanceFileModel {
  @Field(() => String)
  path!: string;

  @Field(() => Boolean)
  exists!: boolean;
}

@ObjectType()
export class RepositoryScriptModel {
  @Field(() => String)
  name!: string;

  @Field(() => String)
  command!: string;
}

@ObjectType()
export class RepositoryContextModel extends RepositoryValidationModel {
  @Field(() => [RepositoryGuidanceFileModel])
  files!: RepositoryGuidanceFileModel[];

  @Field(() => String)
  packageName!: string;

  @Field(() => [RepositoryScriptModel])
  scripts!: RepositoryScriptModel[];

  @Field(() => String)
  packageError!: string;
}
