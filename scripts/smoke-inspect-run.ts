import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { guardSmokeIsolation } from '../src/smoke/isolation.js';

guardSmokeIsolation({ scriptName: 'smoke:inspect-run' });

const { createControlPlaneDataAccess } = await import('../src/control-plane/index.js');

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
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

function matchId(output: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(output);
  if (!match?.[1]) throw new Error(`Could not parse ${label} from CLI output:\n${output}`);
  return match[1];
}

function assertIncludes(str: string, sub: string, label: string): void {
  if (!str.includes(sub)) throw new Error(`${label}: expected output to include "${sub}".\nGot:\n${str}`);
}

// Step 1: create a run with a unique title
const title = `Smoke inspect run ${Date.now()}`;
const createCli = await runCli(['run', 'create', '--title', title, '--repo', '.', '--scope', 'smoke']);
if (createCli.status !== 0) {
  throw new Error(`revo run create failed with ${createCli.status}\nstdout:\n${createCli.stdout}\nstderr:\n${createCli.stderr}`);
}
const runId = matchId(createCli.stdout, /^created run (\S+)$/m, 'run id');
console.log(`created runId=${runId}`);

// Step 2: run list --json; assert the run appears
const listJson = await runCli(['run', 'list', '--json']);
if (listJson.status !== 0) {
  throw new Error(`revo run list --json failed:\n${listJson.stderr}`);
}
const listData = JSON.parse(listJson.stdout) as Array<{ runId: string }>;
if (!listData.some((r) => r.runId === runId)) {
  throw new Error(`run ${runId} not found in list --json output`);
}
console.log(`run list --json: ${listData.length} run(s), run appears OK`);

// Step 3: run show <runId> --json; assert run, task, step are linked
const showJson = await runCli(['run', 'show', runId, '--json']);
if (showJson.status !== 0) {
  throw new Error(`revo run show --json failed:\n${showJson.stderr}`);
}
type ShowOutput = { run: { runId: string; status: string }; tasks: Array<{ taskId: string; steps: Array<{ stepId: string }> }> };
const showData = JSON.parse(showJson.stdout) as ShowOutput;
if (showData.run.runId !== runId) throw new Error(`show: run.runId mismatch: ${showData.run.runId}`);
if (showData.tasks.length !== 1) throw new Error(`show: expected 1 task, got ${showData.tasks.length}`);
if (showData.tasks[0]?.steps.length !== 1) throw new Error(`show: expected 1 step`);
console.log(`run show --json: run=${runId} tasks=${showData.tasks.length} steps=${showData.tasks[0]?.steps.length} OK`);

// Step 4: run events <runId> --json; assert run_created event
const eventsJson = await runCli(['run', 'events', runId, '--json']);
if (eventsJson.status !== 0) {
  throw new Error(`revo run events --json failed:\n${eventsJson.stderr}`);
}
type EventOutput = Array<{ eventId: string; type: string }>;
const eventsData = JSON.parse(eventsJson.stdout) as EventOutput;
const createdEvent = eventsData.find((e) => e.type === 'run_created');
if (!createdEvent) throw new Error(`events: no run_created event found`);
console.log(`run events --json: ${eventsData.length} event(s), run_created OK`);

// Step 5: human output paths — assert non-empty stdout
const listHuman = await runCli(['run', 'list']);
if (listHuman.status !== 0) throw new Error(`revo run list failed:\n${listHuman.stderr}`);
assertIncludes(listHuman.stdout, runId, 'run list human');
assertIncludes(listHuman.stdout, 'RUN', 'run list human header');
console.log(`run list human: OK`);

const showHuman = await runCli(['run', 'show', runId]);
if (showHuman.status !== 0) throw new Error(`revo run show failed:\n${showHuman.stderr}`);
assertIncludes(showHuman.stdout, runId, 'run show human');
console.log(`run show human: OK`);

const eventsHuman = await runCli(['run', 'events', runId]);
if (eventsHuman.status !== 0) throw new Error(`revo run events failed:\n${eventsHuman.stderr}`);
assertIncludes(eventsHuman.stdout, 'run_created', 'run events human');
console.log(`run events human: OK`);

// Step 6: re-read rows and confirm observability did not mutate status/attempt count
const cp = createControlPlaneDataAccess();
const runRow = await cp.getRow('task_runs', runId);
const taskId = showData.tasks[0]?.taskId;
const stepId = showData.tasks[0]?.steps[0]?.stepId;
if (!taskId || !stepId) throw new Error('Missing taskId or stepId from show output');
const taskRow = await cp.getRow('tasks', taskId);
const stepRow = await cp.getRow('steps', stepId);
if (!runRow) throw new Error(`Missing task_runs row ${runId} after inspect`);
if (!taskRow) throw new Error(`Missing tasks row ${taskId} after inspect`);
if (!stepRow) throw new Error(`Missing steps row ${stepId} after inspect`);
if (runRow.data.status !== 'ready') throw new Error(`Run status mutated: ${String(runRow.data.status)}`);
if (taskRow.data.status !== 'ready') throw new Error(`Task status mutated: ${String(taskRow.data.status)}`);
if (stepRow.data.status !== 'ready') throw new Error(`Step status mutated: ${String(stepRow.data.status)}`);
if (stepRow.data.attempt_count !== 0) throw new Error(`Step attempt_count mutated: ${String(stepRow.data.attempt_count)}`);
console.log(`no mutation confirmed: run=${String(runRow.data.status)} task=${String(taskRow.data.status)} step=${String(stepRow.data.status)} attempts=${String(stepRow.data.attempt_count)}`);

// Step 7: unknown run id -> non-zero exit
const unknownShow = await runCli(['run', 'show', 'nonexistent-run-id']);
if (unknownShow.status === 0) throw new Error('run show nonexistent should exit non-zero');
assertIncludes(unknownShow.stderr, 'run not found', 'unknown run show stderr');
const unknownEvents = await runCli(['run', 'events', 'nonexistent-run-id']);
if (unknownEvents.status === 0) throw new Error('run events nonexistent should exit non-zero');
assertIncludes(unknownEvents.stderr, 'run not found', 'unknown run events stderr');
console.log('unknown run id exits non-zero: OK');

console.log('smoke:inspect-run PASSED');
