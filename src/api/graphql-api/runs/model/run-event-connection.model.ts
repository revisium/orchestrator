import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { RunEventModel } from './run-event.model.js';

@ObjectType()
export class RunEventConnection extends Paginated(RunEventModel) {}
