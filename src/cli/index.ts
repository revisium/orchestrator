import 'reflect-metadata';
import { needsHost } from './needs-host.js';
import { buildProgram } from './program.js';

const argv = process.argv;

if (needsHost(argv)) {
  // Host path: dev/status, workflow-mutating commands, and host-backed observability.
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
} else {
  // Host-free path: lifecycle (start/stop/status), the `revo mcp` daemon bridge, revisium, bootstrap,
  // read-only run subcommands, --help, --version, empty/unknown commands.
  // Nest/DBOS are NOT loaded here — fast and safe for daemon-management + client commands.
  await buildProgram().parseAsync(argv);
}
