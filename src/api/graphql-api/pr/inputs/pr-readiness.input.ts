import { Field, InputType, Int } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class PrReadinessInput {
  @Field(() => String)
  repo!: string;

  @Field(() => Int, { nullable: true })
  prNumber?: number;

  @Field(() => String, { nullable: true })
  headBranch?: string;

  @Field(() => String, { nullable: true })
  baseBranch?: string;

  @Field(() => String, { nullable: true })
  sonarProject?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  issueRef?: { repo: string; number: number; url: string };

  @Field(() => Boolean, { nullable: true })
  includeComments?: boolean;

  @Field(() => Boolean, { nullable: true })
  includeReviewThreads?: boolean;
}
