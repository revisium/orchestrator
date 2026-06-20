import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { PipelineModel } from './pipeline.model.js';

@ObjectType()
export class PipelineConnection extends Paginated(PipelineModel) {}
