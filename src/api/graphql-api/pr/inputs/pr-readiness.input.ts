import { Field, InputType, Int } from '@nestjs/graphql';
import { IssueRefInput } from '../../share/model/issue-ref.model.js';

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

  @Field(() => IssueRefInput, { nullable: true })
  issueRef?: IssueRefInput;

  @Field(() => Boolean, { nullable: true })
  includeComments?: boolean;

  @Field(() => Boolean, { nullable: true })
  includeReviewThreads?: boolean;
}
