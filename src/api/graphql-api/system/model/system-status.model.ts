import { Field, ObjectType } from '@nestjs/graphql';
import { DaemonStatusModel } from './daemon-status.model.js';
import { ProjectModel } from './project.model.js';

@ObjectType()
export class SystemStatusModel {
  @Field(() => DaemonStatusModel)
  daemon!: DaemonStatusModel;

  @Field(() => ProjectModel)
  project!: ProjectModel;
}
