import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { RunModel } from './run.model.js';

@ObjectType()
export class RunConnection extends Paginated(RunModel) {}
