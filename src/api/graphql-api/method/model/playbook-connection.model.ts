import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { PlaybookModel } from './playbook.model.js';

@ObjectType()
export class PlaybookConnection extends Paginated(PlaybookModel) {}
