import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { InboxItemModel } from '../../inbox/model/inbox-item.model.js';
import { RunAttemptModel } from './run-attempt.model.js';
import { RunModel } from './run.model.js';
import { UsageModel } from './usage.model.js';

@ObjectType()
export class RunWorkflowPipelineModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  pipelineId!: string;

  @Field(() => String)
  playbookId!: string;

  @Field(() => String)
  title!: string;

  @Field(() => [String])
  routeGates!: string[];

  @Field(() => [String])
  activeNodeIds!: string[];

  @Field(() => String)
  status!: string;
}

@ObjectType()
export class RunWorkflowNodeModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  label!: string;

  @Field(() => String)
  kind!: string;

  @Field(() => String, { nullable: true })
  roleId!: string | null;

  @Field(() => String, { nullable: true })
  scriptId!: string | null;

  @Field(() => String, { nullable: true })
  modelLevel!: string | null;

  @Field(() => String, { nullable: true })
  runner!: string | null;

  @Field(() => String)
  status!: string;

  @Field(() => Int)
  attemptCount!: number;

  @Field(() => Int)
  inputTokens!: number;

  @Field(() => Int)
  outputTokens!: number;

  @Field(() => Float)
  costAmount!: number;

  @Field(() => String, { nullable: true })
  verdict!: string | null;

  @Field(() => ID, { nullable: true })
  inboxId!: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata!: unknown;
}

@ObjectType()
export class RunWorkflowEdgeModel {
  @Field(() => ID)
  from!: string;

  @Field(() => ID)
  to!: string;

  @Field(() => String)
  label!: string;

  @Field(() => String)
  kind!: string;
}

@ObjectType()
export class RunGateStateModel {
  @Field(() => ID)
  nodeId!: string;

  @Field(() => String)
  topic!: string;

  @Field(() => String)
  status!: string;

  @Field(() => ID, { nullable: true })
  inboxId!: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  answer!: unknown;
}

@ObjectType()
export class RunActivityItemModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  type!: string;

  @Field(() => String)
  actor!: string;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => String)
  summary!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  payload!: unknown;
}

@ObjectType()
export class RunWorkflowModel {
  @Field(() => RunModel)
  run!: RunModel;

  @Field(() => RunWorkflowPipelineModel)
  pipeline!: RunWorkflowPipelineModel;

  @Field(() => [RunWorkflowNodeModel])
  nodes!: RunWorkflowNodeModel[];

  @Field(() => [RunWorkflowEdgeModel])
  edges!: RunWorkflowEdgeModel[];

  @Field(() => [String])
  currentNodeIds!: string[];

  @Field(() => [RunGateStateModel])
  gates!: RunGateStateModel[];

  @Field(() => [RunAttemptModel])
  attempts!: RunAttemptModel[];

  @Field(() => [InboxItemModel])
  pendingInbox!: InboxItemModel[];

  @Field(() => UsageModel)
  usage!: UsageModel;

  @Field(() => [RunActivityItemModel])
  activity!: RunActivityItemModel[];
}
