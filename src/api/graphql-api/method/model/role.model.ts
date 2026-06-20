import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class RoleModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  modelLevel!: string;

  @Field(() => String)
  runner!: string;

  @Field(() => String, { nullable: true })
  surface?: string;

  @Field(() => String, { nullable: true })
  rights?: string;

  @Field(() => String, { nullable: true })
  playbookId?: string;

  @Field(() => String, { nullable: true })
  playbookRoleId?: string;

  @Field(() => String, { nullable: true })
  systemPrompt?: string;

  @Field(() => String, { nullable: true })
  effort?: string;

  @Field(() => [String], { nullable: true })
  allowedTools?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  scopeRules?: unknown;

  @Field(() => String, { nullable: true })
  sourcePath?: string;

  @Field(() => String, { nullable: true })
  sourceHash?: string;

  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @Field(() => String, { nullable: true })
  permissionMode?: string;
}
