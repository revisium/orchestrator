import { Module } from '@nestjs/common';
import { DbosService } from './dbos.service.js';

@Module({
  providers: [DbosService],
  exports: [DbosService],
})
export class EngineModule {}
