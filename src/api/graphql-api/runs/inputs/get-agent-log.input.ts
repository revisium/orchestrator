import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { AgentLogStream } from '../model/agent-activity.model.js';

@InputType()
export class GetAgentLogInput {
  @Field(() => ID)
  runId!: string;

  @Field(() => ID, { nullable: true })
  attemptId?: string;

  @Field(() => AgentLogStream)
  stream!: AgentLogStream;

  @Field(() => Int, { nullable: true })
  offsetBytes?: number;

  @Field(() => Int, { nullable: true })
  limitBytes?: number;

  @Field(() => Int, { nullable: true })
  tailBytes?: number;
}
