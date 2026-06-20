import { Global, Module } from '@nestjs/common';
import { DbosService } from './dbos.service.js';

@Global()
@Module({
  providers: [DbosService],
  exports: [DbosService],
})
export class EngineModule {}
