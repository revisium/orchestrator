import { Inject } from '@nestjs/common';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import { RunDigestModel } from './model/run-digest.model.js';
import { RunModel } from './model/run.model.js';

@Resolver(() => RunModel)
export class RunDigestResolver {
  constructor(@Inject(RunsApiService) private readonly api: RunsApiService) {}

  @ResolveField(() => RunDigestModel)
  digest(@Parent() run: RunModel) {
    return this.api.getRunDigest({ runId: run.id });
  }
}
