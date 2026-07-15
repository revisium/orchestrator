import { Module } from '@nestjs/common';
import { AcpRuntimeFactory } from './runtime/factory.js';
import { AcpPermissionRequestHandler } from './prompt-execution/permission-request-handler.js';
import { AcpPromptOutcomeCollector } from './prompt-execution/prompt-outcome-collector.js';
import { AcpInvocation } from './runtime/invocation.js';
import { AcpSession } from './session/session.js';

@Module({
  providers: [
    AcpRuntimeFactory,
    AcpInvocation,
    AcpSession,
    AcpPermissionRequestHandler,
    AcpPromptOutcomeCollector,
  ],
  exports: [AcpRuntimeFactory],
})
export class AcpModule {}
