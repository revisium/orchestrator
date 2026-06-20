import { Field, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { AlternativeRoleGroupModel } from './alternative-role-group.model.js';

@ObjectType()
export class PipelineModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  playbookId!: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => String)
  path!: string;

  @Field(() => [String])
  triggers!: string[];

  @Field(() => [String])
  requiredRoles!: string[];

  @Field(() => [AlternativeRoleGroupModel])
  alternativeRoles!: AlternativeRoleGroupModel[];

  @Field(() => [String])
  optionalRoles!: string[];

  @Field(() => [String])
  routeGates!: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  executionPolicy!: unknown;
}
