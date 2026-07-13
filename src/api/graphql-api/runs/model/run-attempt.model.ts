import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';

@ObjectType()
export class RunAttemptModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  runId!: string;

  @Field(() => String)
  stepId!: string;

  @Field(() => String)
  stepKey!: string;

  @Field(() => Int)
  iteration!: number;

  @Field(() => String)
  status!: string;

  @Field(() => String)
  verdict!: string;

  @Field(() => String)
  runnerId!: string;

  @Field(() => String)
  provider!: string;

  @Field(() => String)
  modelId!: string;

  @Field(() => Int, { nullable: true })
  inputTokens!: number | null;

  @Field(() => Int, { nullable: true })
  outputTokens!: number | null;

  @Field(() => Float, { nullable: true })
  costAmount!: number | null;

  @Field(() => String, { nullable: true })
  currency!: string | null;

  @Field(() => Int)
  durationMs!: number;

  @Field(() => String)
  outputSummary!: string;

  @Field(() => String)
  artifactRef!: string;

  @Field(() => String)
  lesson!: string;

  @Field(() => String)
  error!: string;

  @Field(() => Date)
  startedAt!: Date;
}

@ObjectType()
export class RunAttemptConnection extends Paginated(RunAttemptModel) {}
