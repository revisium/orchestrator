import { Injectable } from '@nestjs/common';
import type { AcpPromptOutcome } from '../prompt-execution/prompt-outcome-collector.js';
import {
  runAcpInvocation,
  type AcpInvocationDependencies,
  type AcpInvocationRequest,
} from './invocation.js';

@Injectable()
export class AcpRuntimeFactory {
  runInvocation(
    request: AcpInvocationRequest,
    deps: AcpInvocationDependencies,
  ): Promise<AcpPromptOutcome> {
    return runAcpInvocation(request, deps);
  }
}
