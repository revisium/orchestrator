import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

export enum AgentLogStream {
  stdout = 'stdout',
  stderr = 'stderr',
  events = 'events',
  combined = 'combined',
}

export enum AgentActivityStatus {
  starting = 'starting',
  running = 'running',
  idle = 'idle',
  permission_blocked = 'permission_blocked',
  cancelled = 'cancelled',
  exited = 'exited',
  timed_out = 'timed_out',
  failed = 'failed',
}

export enum AgentOutputStream {
  stdout = 'stdout',
  stderr = 'stderr',
  agent_jsonl = 'agent_jsonl',
}

@ObjectType('AgentAttempt')
export class AgentAttemptModel {
  @Field(() => ID)
  runId!: string;

  @Field(() => ID)
  attemptId!: string;

  @Field(() => ID)
  stepId!: string;

  @Field(() => String, { nullable: true })
  stepKey?: string;

  @Field(() => String)
  role!: string;

  @Field(() => String)
  runner!: string;

  @Field(() => String)
  artifactRef!: string;

  @Field(() => Date)
  startedAt!: Date;

  @Field(() => Date, { nullable: true })
  finishedAt?: Date;

  @Field(() => String)
  status!: string;

  @Field(() => Int, { nullable: true })
  exitCode?: number | null;

  @Field(() => Boolean, { nullable: true })
  timedOut?: boolean;

  @Field(() => Int)
  stdoutBytes!: number;

  @Field(() => Int)
  stderrBytes!: number;
}

@ObjectType('AgentActivity')
export class AgentActivityModel {
  @Field(() => ID)
  runId!: string;

  @Field(() => ID)
  attemptId!: string;

  @Field(() => ID)
  stepId!: string;

  @Field(() => String, { nullable: true })
  stepKey?: string;

  @Field(() => String)
  role!: string;

  @Field(() => String)
  runner!: string;

  @Field(() => Int, { nullable: true })
  pid?: number;

  @Field(() => AgentActivityStatus)
  status!: AgentActivityStatus;

  @Field(() => Date)
  startedAt!: Date;

  @Field(() => Date)
  lastEventAt!: Date;

  @Field(() => Date, { nullable: true })
  lastOutputAt?: Date;

  @Field(() => AgentOutputStream, { nullable: true })
  lastStream?: AgentOutputStream;

  @Field(() => Int)
  stdoutBytes!: number;

  @Field(() => Int)
  stderrBytes!: number;

  @Field(() => Int)
  eventCount!: number;

  @Field(() => String)
  artifactRef!: string;

  @Field(() => Int, { nullable: true })
  exitCode?: number | null;

  @Field(() => Boolean, { nullable: true })
  timedOut?: boolean;

  @Field(() => String, { nullable: true })
  error?: string;
}

@ObjectType('AgentRunActivity')
export class AgentRunActivityModel {
  @Field(() => ID)
  runId!: string;

  @Field(() => AgentActivityStatus)
  aggregateStatus!: AgentActivityStatus;

  @Field(() => Date)
  latestActivityAt!: Date;

  @Field(() => Date, { nullable: true })
  latestOutputAt?: Date;

  @Field(() => [AgentActivityModel])
  attempts!: AgentActivityModel[];
}

@ObjectType('AgentLogChunk')
export class AgentLogChunkModel {
  @Field(() => ID)
  runId!: string;

  @Field(() => ID)
  attemptId!: string;

  @Field(() => AgentLogStream)
  stream!: AgentLogStream;

  @Field(() => Int)
  offsetBytes!: number;

  @Field(() => Int, { nullable: true })
  nextOffsetBytes?: number;

  @Field(() => Int, { nullable: true })
  totalBytes?: number;

  @Field(() => Boolean)
  truncated!: boolean;

  @Field(() => String)
  content!: string;
}
