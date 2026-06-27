import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import type { IssueRef } from '../../../../run/issue-ref.js';

@InputType()
export class IssueRefInput implements IssueRef {
  @Field(() => String)
  repo!: string;

  @Field(() => Int)
  number!: number;

  @Field(() => String)
  url!: string;
}

@ObjectType()
export class IssueRefModel implements IssueRef {
  @Field(() => String)
  repo!: string;

  @Field(() => Int)
  number!: number;

  @Field(() => String)
  url!: string;
}
