import { Field, InputType, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class BindingOverrideMatchInput {
  @Field(() => String, { nullable: true })
  roleId?: string;

  @Field(() => String, { nullable: true })
  nodeId?: string;

  @Field(() => String, { nullable: true })
  runnerId?: string;
}

@InputType()
export class BindingOverrideInput {
  @Field(() => BindingOverrideMatchInput)
  match!: BindingOverrideMatchInput;

  @Field(() => String, { nullable: true })
  runnerId?: string;

  @Field(() => String, { nullable: true })
  modelLevel?: string;

  @Field(() => Int, { nullable: true })
  timeoutMs?: number;

  @Field(() => String, { nullable: true })
  permissionMode?: string;
}

@InputType()
export class ExecutionProfileInput {
  @Field(() => GraphQLJSON, { nullable: true })
  runnerOverrides?: unknown;

  @Field(() => [String], { nullable: true })
  availableRunners?: string[];

  @Field(() => [BindingOverrideInput], { nullable: true })
  bindingOverrides?: BindingOverrideInput[];
}
