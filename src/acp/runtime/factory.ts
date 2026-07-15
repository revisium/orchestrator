import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AcpPromptOutcome } from '../prompt-execution/prompt-outcome-collector.js';
import {
  AcpInvocation,
  type AcpInvocationDependencies,
  type AcpInvocationRequest,
} from './invocation.js';

@Injectable()
export class AcpRuntimeFactory {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  async runInvocation(
    request: AcpInvocationRequest,
    deps: AcpInvocationDependencies,
  ): Promise<AcpPromptOutcome> {
    const invocation = await this.moduleRef.resolve(AcpInvocation);
    return invocation.run(request, deps);
  }
}
