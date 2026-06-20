import { Field, Int, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';

@ObjectType()
export class PrInfoModel {
  @Field(() => Int, { nullable: true })
  number!: number | null;

  @Field(() => String)
  url!: string;

  @Field(() => String)
  state!: string;

  @Field(() => Boolean)
  draft!: boolean;

  @Field(() => String)
  base!: string;

  @Field(() => String)
  head!: string;

  @Field(() => String)
  headSha!: string;

  @Field(() => String)
  mergeState!: string;
}

@ObjectType()
export class PrCheckModel {
  @Field(() => String)
  name!: string;

  @Field(() => String)
  result!: string;
}

@ObjectType()
export class PrChecksModel {
  @Field(() => [String])
  terminal!: string[];

  @Field(() => [String])
  pending!: string[];

  @Field(() => [String])
  pass!: string[];

  @Field(() => [String])
  fail!: string[];

  @Field(() => [PrCheckModel])
  list!: PrCheckModel[];
}

@ObjectType()
export class PrReviewThreadModel {
  @Field(() => String)
  id!: string;

  @Field(() => Boolean)
  isResolved!: boolean;

  @Field(() => Boolean)
  isOutdated!: boolean;

  @Field(() => String, { nullable: true })
  path!: string | null;

  @Field(() => Int, { nullable: true })
  line!: number | null;

  @Field(() => String, { nullable: true })
  author!: string | null;

  @Field(() => String)
  body!: string;

  @Field(() => String, { nullable: true })
  url!: string | null;
}

@ObjectType()
export class PrReviewThreadsModel {
  @Field(() => Boolean)
  included!: boolean;

  @Field(() => Int)
  unresolvedCount!: number;

  @Field(() => [PrReviewThreadModel])
  items!: PrReviewThreadModel[];
}

@ObjectType()
export class PrSonarIssueModel {
  @Field(() => String)
  severity!: string;

  @Field(() => String)
  message!: string;

  @Field(() => String)
  component!: string;

  @Field(() => String, { nullable: true })
  rule!: string | null;

  @Field(() => Int, { nullable: true })
  line!: number | null;
}

@ObjectType()
export class PrSonarHotspotModel {
  @Field(() => String)
  message!: string;

  @Field(() => String)
  component!: string;

  @Field(() => Int, { nullable: true })
  line!: number | null;

  @Field(() => String, { nullable: true })
  securityCategory!: string | null;

  @Field(() => String, { nullable: true })
  vulnerabilityProbability!: string | null;
}

@ObjectType()
export class PrSonarModel {
  @Field(() => Boolean)
  configured!: boolean;

  @Field(() => Boolean)
  unavailable!: boolean;

  @Field(() => [PrSonarIssueModel])
  issues!: PrSonarIssueModel[];

  @Field(() => [PrSonarHotspotModel])
  hotspots!: PrSonarHotspotModel[];
}

@ObjectType()
export class PrFeedbackItemModel {
  @Field(() => String, { nullable: true })
  source!: string | null;

  @Field(() => String, { nullable: true })
  summary!: string | null;

  @Field(() => String, { nullable: true })
  evidence!: string | null;

  @Field(() => String, { nullable: true })
  severity!: string | null;

  @Field(() => String, { nullable: true })
  location!: string | null;

  @Field(() => String, { nullable: true })
  author!: string | null;

  @Field(() => String, { nullable: true })
  provider!: string | null;

  @Field(() => String, { nullable: true })
  reason!: string | null;
}

@ObjectType()
export class PrFeedbackModel {
  @Field(() => [PrFeedbackItemModel])
  developerFixes!: PrFeedbackItemModel[];

  @Field(() => [PrFeedbackItemModel])
  reviewerQuestions!: PrFeedbackItemModel[];

  @Field(() => [PrFeedbackItemModel])
  providerWait!: PrFeedbackItemModel[];

  @Field(() => [PrFeedbackItemModel])
  humanDecisions!: PrFeedbackItemModel[];

  @Field(() => [PrFeedbackItemModel])
  ignoredNoise!: PrFeedbackItemModel[];

  @Field(() => [String])
  residualRisks!: string[];
}

@ObjectType()
export class PrReadinessModel {
  @Field(() => String)
  verdict!: string;

  @Field(() => String)
  nextAction!: string;

  @Field(() => PrInfoModel)
  pr!: PrInfoModel;

  @Field(() => PrChecksModel)
  checks!: PrChecksModel;

  @Field(() => String)
  reviewDecision!: string;

  @Field(() => PrReviewThreadsModel)
  reviewThreads!: PrReviewThreadsModel;

  @Field(() => PrSonarModel)
  sonar!: PrSonarModel;

  @Field(() => [String])
  evidence!: string[];

  @Field(() => PrFeedbackModel)
  feedback!: PrFeedbackModel;

  @Field(() => GraphQLJSON)
  providerState!: unknown;

  @Field(() => GraphQLJSON)
  ciSummary!: unknown;
}
