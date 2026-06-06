import 'reflect-metadata';
import { needsHost } from './needs-host.js';
import { buildProgram } from './program.js';

const argv = process.argv;

if (!needsHost(argv)) {
  // Host-free path: revisium start/stop/status/logs, bootstrap, run, work,
  // --help, --version, empty/unknown commands.
  // Nest/DBOS are NOT loaded here — fast and safe for daemon-management commands.
  await buildProgram().parseAsync(argv);
} else {
  // Host path: dev:ping, dev:status (and future run/work when they move onto DBOS).
  // Nest/DBOS/AppModule are imported lazily so the host-free path never loads them.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    await buildProgram(app).parseAsync(argv);
  } finally {
    // onApplicationShutdown → DBOS.shutdown() only; daemon is NOT stopped (Round 3).
    await app.close();
  }
}
