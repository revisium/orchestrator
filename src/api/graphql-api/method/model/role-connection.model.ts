import { ObjectType } from '@nestjs/graphql';
import { Paginated } from '../../share/model/paginated.model.js';
import { RoleModel } from './role.model.js';

@ObjectType()
export class RoleConnection extends Paginated(RoleModel) {}
