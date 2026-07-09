import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { RunProfileModel } from './run-profile.model.js';

@ObjectType()
export class RunProfileConnection extends Paginated(RunProfileModel) {}
