import { Field, ObjectType } from '@nestjs/graphql';
import { InboxItemModel } from '../../inbox/model/inbox-item.model.js';
import { RunEventModel } from './run-event.model.js';
import { RunModel } from './run.model.js';
import { UsageModel } from './usage.model.js';

@ObjectType()
export class RunDigestModel {
  @Field(() => RunModel)
  run!: RunModel;

  @Field(() => [InboxItemModel])
  pendingInbox!: InboxItemModel[];

  @Field(() => [RunEventModel])
  latestEvents!: RunEventModel[];

  @Field(() => UsageModel)
  usage!: UsageModel;
}
