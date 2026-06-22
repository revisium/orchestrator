import 'reflect-metadata';
import { isMcpCommand, needsHost } from './needs-host.js';
import { buildProgram } from './program.js';

const argv = process.argv;

if (needsHost(argv)) {
  // Host path: dev/status, workflow-mutating commands, MCP, and host-backed observability.
  // Nest/DBOS/AppModule are imported lazily so the host-free path never loads them.
  const mcpCommand = isMcpCommand(argv);
  if (mcpCommand) {
    process.env.REVO_MCP_STDIO = '1';
  } else {
    delete process.env.REVO_MCP_STDIO;
  }
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: mcpCommand ? false : ['error', 'warn'] });
  try {
    await buildProgram(app).parseAsync(argv);
  } finally {
    // onApplicationShutdown → DBOS.shutdown() only; daemon is NOT stopped (Round 3).
    await app.close();
  }
} else {
  // Host-free path: revisium start/stop/status/logs, bootstrap, legacy read-only run subcommands, work,
  // --help, --version, empty/unknown commands.
  // Nest/DBOS are NOT loaded here — fast and safe for daemon-management commands.
  await buildProgram().parseAsync(argv);
}
