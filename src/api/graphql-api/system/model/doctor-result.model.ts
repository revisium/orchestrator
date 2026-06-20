import { Field, ObjectType } from '@nestjs/graphql';
import { SystemStatusModel } from './system-status.model.js';

@ObjectType()
export class DoctorResultModel {
  @Field(() => Boolean)
  ok!: boolean;

  @Field(() => [String])
  issues!: string[];

  @Field(() => SystemStatusModel)
  status!: SystemStatusModel;
}
