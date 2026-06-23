// reflect-metadata is required by the daemon entrypoint (`revo __daemon` → NestFactory); load it once
// here so it is present whichever command runs.
import 'reflect-metadata';
import { buildProgram } from './program.js';

// The CLI is a lightweight client/process-manager (ADR 0006): it NEVER builds AppModule or launches
// DBOS. The only long-lived host is the daemon, spawned detached via the hidden `__daemon` command.
await buildProgram().parseAsync(process.argv);
