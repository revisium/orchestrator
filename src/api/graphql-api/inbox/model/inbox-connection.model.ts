import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { InboxItemModel } from './inbox-item.model.js';

@ObjectType()
export class InboxConnection extends Paginated(InboxItemModel) {}
