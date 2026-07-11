import 'reflect-metadata';
import { createCrashCheckpoint } from '../../support/recovery-context.js';

const stopAt = process.argv[2] === 'merge-gate' ? 'merge-gate' : 'plan-gate';
const run = await createCrashCheckpoint({ dataDriven: true, stopAt });
process.stdout.write(`RUNID=${run.runId}\nTASKID=${run.taskId}\nREPO=${run.repo}\n`, () => process.exit(0));
