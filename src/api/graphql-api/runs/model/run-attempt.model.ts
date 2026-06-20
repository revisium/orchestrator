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
  modelProfile!: string;

  @Field(() => Int)
  inputTokens!: number;

  @Field(() => Int)
  outputTokens!: number;

  @Field(() => Float)
  costAmount!: number;

  @Field(() => String)
  currency!: string;

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
