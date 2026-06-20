import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class AlternativeRoleGroupModel {
  @Field(() => String)
  groupId!: string;

  @Field(() => [String])
  roles!: string[];

  @Field(() => String)
  resolution!: string;
}
