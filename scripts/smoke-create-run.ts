import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createControlPlaneDataAccess } from '../src/control-plane/index.js';

const require = createRequire(import.meta.url);
const tsxPackagePath = require.resolve('tsx/package.json');
const tsxPackage = require(tsxPackagePath) as { bin: string | Record<string, string> };
const tsxBin = typeof tsxPackage.bin === 'string' ? tsxPackage.bin : tsxPackage.bin.tsx;
if (!tsxBin) throw new Error('Could not resolve tsx CLI path from package.json');
const tsxCliPath = join(dirname(tsxPackagePath), tsxBin);

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli/index.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

function matchId(output: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(output);
  if (!match?.[1]) throw new Error(`Could not parse ${label} from CLI output:\n${output}`);
  return match[1];
}

const title = `Smoke create run ${Date.now()}`;
const cli = await runCli([
  'run',
  'create',
  '--title',
  title,
  '--repo',
  '.',
  '--description',
  'Plan 0003 smoke',
  '--scope',
  'smoke',
  '--priority',
  '1',
]);

if (cli.status !== 0) {
  throw new Error(`revo run create failed with ${cli.status}\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`);
}

const runId = matchId(cli.stdout, /^created run (\S+)$/m, 'run id');
const taskId = matchId(cli.stdout, /^task (\S+)$/m, 'task id');
const stepId = matchId(cli.stdout, /^step (\S+) ready$/m, 'step id');
const eventId = matchId(cli.stdout, /^event (\S+)$/m, 'event id');

const cp = createControlPlaneDataAccess();
const run = await cp.getRow('task_runs', runId);
const task = await cp.getRow('tasks', taskId);
const step = await cp.getRow('steps', stepId);
const event = await cp.getRow('events', eventId);

if (!run) throw new Error(`Missing draft task_runs row ${runId}`);
if (!task) throw new Error(`Missing draft tasks row ${taskId}`);
if (!step) throw new Error(`Missing draft steps row ${stepId}`);
if (!event) throw new Error(`Missing draft events row ${eventId}`);

if (run.data.status !== 'ready') throw new Error(`Unexpected run status: ${String(run.data.status)}`);
if (task.data.status !== 'ready') throw new Error(`Unexpected task status: ${String(task.data.status)}`);
if (step.data.status !== 'ready') throw new Error(`Unexpected step status: ${String(step.data.status)}`);
if (task.data.run_id !== runId) throw new Error(`Task ${taskId} does not point at run ${runId}`);
if (step.data.task_id !== taskId || step.data.run_id !== runId) {
  throw new Error(`Step ${stepId} does not point at task/run`);
}
if (event.data.type !== 'run_created') throw new Error(`Unexpected event type: ${String(event.data.type)}`);
if (typeof step.data.input !== 'object' || step.data.input === null || Array.isArray(step.data.input)) {
  throw new Error('Step input did not deserialize to an object');
}
if (typeof event.data.payload !== 'object' || event.data.payload === null || Array.isArray(event.data.payload)) {
  throw new Error('Event payload did not deserialize to an object');
}

const headCp = createControlPlaneDataAccess({ revision: 'head' });
const headRun = await headCp.getRow('task_runs', runId);
if (headRun !== null) {
  throw new Error(`Smoke run ${runId} unexpectedly visible from head`);
}

console.log(`smokeRunId=${runId}`);
console.log(`smokeTaskId=${taskId}`);
console.log(`smokeStepId=${stepId}`);
console.log(`smokeEventId=${eventId}`);
console.log('draftContainsSmokeRows=true');
console.log('headContainsSmokeRun=false');
