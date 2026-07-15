import { Module } from '@nestjs/common';
import { AcpRuntimeFactory } from './runtime/factory.js';

@Module({
  providers: [AcpRuntimeFactory],
  exports: [AcpRuntimeFactory],
})
export class AcpModule {}
