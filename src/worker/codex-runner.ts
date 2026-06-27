import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ModelProfile, Role } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';
import type { AgentActivityReporter } from '../observability/agent-activity-reporter.js';
import type { RunnerActivityTracker } from '../observability/activity-signal.js';
import type { ArtifactStore } from './artifact-store.js';
import {
  resolveEffectiveRunnerTimeoutPolicy,
  type ExecRequest,
  type ProcessExecutor,
} from './process-executor.js';
import type { RunAgent } from './runner.js';
import { RunAgentError } from './runner.js';
import {
  boundedPreview,
  boundedPreviewValue,
  buildAttemptResult,
  buildUsageCosts,
  runnerError,
  runnerTimeoutFailure,
  tail,
} from './runner-common.js';

export type CodexRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>;
  artifactStore: ArtifactStore;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  command?: string;
};

type CodexAgentResult = {
  verdict: string;
  output: unknown;
  artifacts?: unknown;
  nextSteps: unknown[];
  needsHuman: boolean;
  lesson?: string;
};

type CodexJsonlSummary = {
  finalStructured?: unknown;
  failedMessage?: string;
  permissionBlocked: boolean;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
};

const DEFAULT_COMMAND = 'codex';

export const CODEX_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'string',
      minLength: 1,
      description: 'the single routing token for the role, lowercase',
    },
    output: {
      description: 'the structured or textual output consumed by the orchestrator',
    },
    artifacts: {
      description: 'nullable JSON artifacts; use null when there are no artifacts',
    },
    nextSteps: {
      anyOf: [
        {
          type: 'array',
          description: 'follow-up step specs; use [] when no follow-up work is needed',
          items: { type: 'object' },
        },
        { type: 'null' },
      ],
    },
    needsHuman: {
      anyOf: [{ type: 'boolean' }, { type: 'null' }],
      description: 'true only when a human must intervene; null is normalized to false',
    },
    lesson: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'nullable one-line lesson for a future attempt',
    },
  },
  required: ['verdict', 'output', 'artifacts', 'nextSteps', 'needsHuman', 'lesson'],
} as const;

const STRUCTURED_RESULT_NOTE = `
Return only JSON matching the provided output schema as your final answer.
All fields are required: verdict, output, artifacts, nextSteps, needsHuman, lesson.
Use null for nullable fields when they do not apply. Do not put the result only in prose.
`;

function writeCodexOutputSchema(processDir: string): string {
  mkdirSync(processDir, { recursive: true });
  const schemaPath = join(processDir, 'codex-output.schema.json');
  writeFileSync(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2) + '\n', 'utf8');
  return schemaPath;
}

function buildPrompt(context: string, attemptId: string): string {
  const idempotencyLine = `Attempt-Id: ${attemptId} - idempotency key. Reference it on any external effect you create.`;
  return [context, idempotencyLine, STRUCTURED_RESULT_NOTE].join('\n');
}

function isOpenAiCompatibleProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized.includes('openai') || normalized.includes('codex');
}

const WRITE_TOOL_NAMES = new Set(['edit', 'multiedit', 'notebookedit', 'write']);
const READ_ONLY_RIGHTS = new Set([
  '',
  'deploy-read',
  'qa-live',
  'read only',
  'read-only',
  'read-only pr inspection',
  'readonly',
  'state and routing only',
]);
const WORKSPACE_WRITE_RIGHTS = new Set([
  'git and github writes',
  'git-gh',
  'write',
  'write working tree',
  'write-working-tree',
  'working tree write',
  'working-tree-write',
]);

function normalizedPolicyLabel(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replaceAll('_', '-').replace(/\s+/g, ' ');
}

function isWriteToolName(tool: string): boolean {
  const normalized = tool.trim().toLowerCase();
  return WRITE_TOOL_NAMES.has(normalized);
}

function sandboxForRole(role: Role): 'read-only' | 'workspace-write' {
  if (role.allowedTools.some(isWriteToolName)) return 'workspace-write';

  const rights = normalizedPolicyLabel(role.rights);
  if (WORKSPACE_WRITE_RIGHTS.has(rights)) return 'workspace-write';
  if (READ_ONLY_RIGHTS.has(rights)) return 'read-only';

  if (rights.length > 0) {
    throw new Error(`codex runner does not know how to map role rights "${role.rights}" to a sandbox`);
  }
  return 'read-only';
}

function buildArgs(modelId: string, sandbox: 'read-only' | 'workspace-write', cwd: string, schemaPath: string): string[] {
  return [
    'exec',
    '--json',
    '--output-schema',
    schemaPath,
    '-c',
    'approval_policy="never"',
    '--model',
    modelId,
    '--sandbox',
    sandbox,
    '--cd',
    cwd,
    '--ephemeral',
    '--ignore-user-config',
    '--color',
    'never',
    '-',
  ];
}

function requireCompatibleProfile(profile: ModelProfile): void {
  if (profile.modelId.trim().length === 0) {
    throw new Error('codex runner requires a non-empty model_profiles.model_id');
  }
  if (!isOpenAiCompatibleProvider(profile.provider)) {
    throw new Error(`codex runner requires an OpenAI/Codex-compatible provider, got "${profile.provider}"`);
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function maybeObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isStructuredCandidate(value: unknown): boolean {
  const obj = maybeObject(value);
  return Boolean(obj && 'verdict' in obj && 'output' in obj);
}

function parseJsonObjectText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function candidateFromContentArray(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const obj = maybeObject(entry);
    const text = readString(obj?.text) ?? readString(obj?.content);
    if (!text) continue;
    const parsed = parseJsonObjectText(text);
    if (isStructuredCandidate(parsed)) return parsed;
  }
  return undefined;
}

const TERMINAL_STRUCTURED_KEYS = ['structured_output', 'structuredOutput', 'final_output', 'finalOutput'] as const;
const TERMINAL_OBJECT_KEYS = ['output', 'result'] as const;
const TERMINAL_CONTENT_HOLDER_KEYS = ['output'] as const;
const TERMINAL_TEXT_KEYS = ['output_text', 'text', 'result'] as const;

function structuredCandidateFromObjectKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const candidate = source[key];
    if (isStructuredCandidate(candidate)) return candidate;
  }
  return undefined;
}

function structuredCandidateFromContentHolder(value: unknown): unknown {
  const obj = maybeObject(value);
  if (!obj) return undefined;

  const outputCandidate = structuredCandidateFromObjectKeys(obj, TERMINAL_CONTENT_HOLDER_KEYS);
  return outputCandidate ?? candidateFromContentArray(obj.content);
}

function structuredCandidateFromTextKeys(source: Record<string, unknown>): unknown {
  for (const key of TERMINAL_TEXT_KEYS) {
    const value = readString(source[key]);
    if (!value) continue;
    const parsed = parseJsonObjectText(value);
    if (isStructuredCandidate(parsed)) return parsed;
  }
  return undefined;
}

function structuredCandidateFromTerminalEvent(event: Record<string, unknown>): unknown {
  if (event.type !== 'turn.completed') return undefined;

  return structuredCandidateFromObjectKeys(event, TERMINAL_STRUCTURED_KEYS)
    ?? structuredCandidateFromObjectKeys(event, TERMINAL_OBJECT_KEYS)
    ?? structuredCandidateFromContentHolder(event.item)
    ?? structuredCandidateFromContentHolder(event.message)
    ?? structuredCandidateFromTextKeys(event);
}

function eventFailureMessage(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'turn.failed') return undefined;
  const error = maybeObject(event.error);
  return readString(event.message)
    ?? readString(event.reason)
    ?? readString(error?.message)
    ?? readString(error?.code)
    ?? JSON.stringify(boundedPreviewValue(event));
}

function permissionBlockedText(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(boundedPreviewValue(value));
  return /\b(permission|approval|approve|sandbox|policy)\b/i.test(text)
    && /\b(denied|blocked|disallowed|not allowed|forbidden|rejected|never)\b/i.test(text);
}

function usageFromEvent(event: Record<string, unknown>): {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
} {
  const usage = maybeObject(event.usage) ?? maybeObject(event.token_usage) ?? {};
  return {
    costUsd: readNumber(event.total_cost_usd) ?? readNumber(event.cost_usd) ?? readNumber(usage.cost_usd),
    inputTokens:
      readNumber(event.input_tokens)
      ?? readNumber(event.inputTokens)
      ?? readNumber(usage.input_tokens)
      ?? readNumber(usage.inputTokens),
    outputTokens:
      readNumber(event.output_tokens)
      ?? readNumber(event.outputTokens)
      ?? readNumber(usage.output_tokens)
      ?? readNumber(usage.outputTokens),
  };
}

function parseJsonlEvent(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`codex exec returned malformed JSONL at line ${lineNumber}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`codex exec returned non-object JSONL at line ${lineNumber}`);
  }
  return parsed as Record<string, unknown>;
}

function reportJsonlEvent(event: Record<string, unknown>, reporter?: AgentActivityReporter): void {
  reporter?.parsed({ type: readString(event.type) ?? 'event', preview: boundedPreview(event) });
}

function recordCodexJsonlActivity(
  event: Record<string, unknown>,
  activity: RunnerActivityTracker | undefined,
): void {
  const type = readString(event.type) ?? 'event';
  activity?.markActivity(type === 'heartbeat' ? 'heartbeat' : 'event');
}

function applyUsageSummary(summary: CodexJsonlSummary, event: Record<string, unknown>): void {
  const usage = usageFromEvent(event);
  summary.costUsd = usage.costUsd ?? summary.costUsd;
  summary.inputTokens = usage.inputTokens ?? summary.inputTokens;
  summary.outputTokens = usage.outputTokens ?? summary.outputTokens;
}

function applyFailureSummary(summary: CodexJsonlSummary, event: Record<string, unknown>): void {
  const failure = eventFailureMessage(event);
  if (!failure) return;
  summary.failedMessage = failure;
  summary.permissionBlocked ||= permissionBlockedText(event);
}

function applyStructuredSummary(summary: CodexJsonlSummary, event: Record<string, unknown>): void {
  const structured = structuredCandidateFromTerminalEvent(event);
  if (structured !== undefined) summary.finalStructured = structured;
}

function summarizeCodexEvents(events: Record<string, unknown>[]): CodexJsonlSummary {
  if (events.length === 0) throw new Error('codex exec did not return JSONL events');
  const summary: CodexJsonlSummary = { permissionBlocked: false };
  for (const event of events) {
    applyUsageSummary(summary, event);
    applyFailureSummary(summary, event);
    applyStructuredSummary(summary, event);
  }
  return summary;
}

function parseCodexJsonl(
  stdout: string,
  reporter?: AgentActivityReporter,
  activity?: RunnerActivityTracker,
): CodexJsonlSummary {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = lines.map((line, index) => {
    const event = parseJsonlEvent(line, index + 1);
    recordCodexJsonlActivity(event, activity);
    reportJsonlEvent(event, reporter);
    return event;
  });
  return summarizeCodexEvents(events);
}

function createStreamingJsonlCollector(
  reporter?: AgentActivityReporter,
  activity?: () => RunnerActivityTracker | undefined,
): {
  append(chunk: string): void;
  finish(fallbackStdout: string): CodexJsonlSummary;
} {
  let buffered = '';
  let received = '';
  const parsedEvents: Record<string, unknown>[] = [];
  let parseError: Error | undefined;

  function parseLine(line: string): void {
    if (line.trim().length === 0) return;
    try {
      const event = parseJsonlEvent(line, parsedEvents.length + 1);
      parsedEvents.push(event);
      recordCodexJsonlActivity(event, activity?.());
      reportJsonlEvent(event, reporter);
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    append(chunk): void {
      received += chunk;
      buffered += chunk;
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? '';
      for (const part of parts) parseLine(part);
    },
    finish(fallbackStdout): CodexJsonlSummary {
      if (received.length === 0) return parseCodexJsonl(fallbackStdout, reporter, activity?.());
      parseLine(buffered);
      if (parseError) throw parseError;
      return summarizeCodexEvents(parsedEvents);
    },
  };
}

type SchemaValidationIssue = {
  path: string;
  message: string;
};

function validateCodexOutputAgainstSchema(value: unknown): SchemaValidationIssue[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: '$', message: 'must be an object' }];
  }
  const obj = value as Record<string, unknown>;
  return [
    ...missingRequiredIssues(obj),
    ...additionalPropertyIssues(obj),
    ...fieldTypeIssues(obj),
    ...nextStepEntryIssues(obj),
  ];
}

function missingRequiredIssues(obj: Record<string, unknown>): SchemaValidationIssue[] {
  return CODEX_OUTPUT_SCHEMA.required
    .filter((key) => !(key in obj))
    .map((key) => ({ path: `$.${key}`, message: 'is required' }));
}

function additionalPropertyIssues(obj: Record<string, unknown>): SchemaValidationIssue[] {
  if (CODEX_OUTPUT_SCHEMA.additionalProperties === false) {
    const allowed = new Set(Object.keys(CODEX_OUTPUT_SCHEMA.properties));
    return Object.keys(obj)
      .filter((key) => !allowed.has(key))
      .map((key) => ({ path: `$.${key}`, message: 'is not allowed by schema' }));
  }
  return [];
}

function fieldTypeIssues(obj: Record<string, unknown>): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  if ('verdict' in obj && (typeof obj.verdict !== 'string' || obj.verdict.trim().length === 0)) {
    issues.push({ path: '$.verdict', message: 'must be a non-empty string' });
  }
  if ('nextSteps' in obj && obj.nextSteps !== null && !Array.isArray(obj.nextSteps)) {
    issues.push({ path: '$.nextSteps', message: 'must be an array or null' });
  }
  if ('needsHuman' in obj && obj.needsHuman !== null && typeof obj.needsHuman !== 'boolean') {
    issues.push({ path: '$.needsHuman', message: 'must be a boolean or null' });
  }
  if ('lesson' in obj && obj.lesson !== null && typeof obj.lesson !== 'string') {
    issues.push({ path: '$.lesson', message: 'must be a string or null' });
  }

  return issues;
}

function nextStepEntryIssues(obj: Record<string, unknown>): SchemaValidationIssue[] {
  if (!Array.isArray(obj.nextSteps)) return [];
  return obj.nextSteps.flatMap((entry, index) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? []
      : [{ path: `$.nextSteps[${index}]`, message: 'must be an object' }],
  );
}

function normalizeCodexResult(structured: unknown): CodexAgentResult {
  if (structured === undefined) throw new TypeError('codex structured result missing final schema output');
  const issues = validateCodexOutputAgainstSchema(structured);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw new TypeError(`codex structured result violates output schema: ${detail}`);
  }
  const obj = structured as Record<string, unknown>;
  return {
    verdict: obj.verdict as string,
    output: obj.output,
    artifacts: obj.artifacts === null ? undefined : obj.artifacts,
    nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps : [],
    needsHuman: obj.needsHuman === true,
    lesson: typeof obj.lesson === 'string' ? obj.lesson : undefined,
  };
}

export function createCodexRunner(deps: CodexRunnerDeps): RunAgent {
  const defaultTimeoutPolicy = resolveEffectiveRunnerTimeoutPolicy({
    idleTimeoutMs: deps.idleTimeoutMs,
    wallClockLimitMs: deps.timeoutMs,
  });
  const command = deps.command ?? DEFAULT_COMMAND;

  return async ({ role, profile, context, attemptId, step, reporter }) => {
    let processArtifact: ReturnType<ArtifactStore['startProcess']> | undefined;
    let processActivity: RunnerActivityTracker | undefined;
    try {
      requireCompatibleProfile(profile);
      const timeoutPolicy = resolveEffectiveRunnerTimeoutPolicy({
        idleTimeoutMs: defaultTimeoutPolicy.idleTimeoutMs,
        wallClockLimitMs: defaultTimeoutPolicy.wallClockLimitMs,
        roleTimeoutMs: role.timeoutMs,
      });
      const cwd = await deps.resolveCwd(step);
      const sandbox = sandboxForRole(role);
      const schemaPath = writeCodexOutputSchema(deps.artifactStore.resolveAttemptDir(step.runId, attemptId));
      const args = buildArgs(profile.modelId, sandbox, cwd, schemaPath);
      processArtifact = deps.artifactStore.startProcess({
        runId: step.runId,
        attemptId,
        stepId: step.id,
        role: role.name,
        runner: role.runner,
        command,
        args,
        cwd,
        timeoutMs: timeoutPolicy.wallClockLimitMs,
        idleTimeoutMs: timeoutPolicy.idleTimeoutMs,
        wallClockLimitMs: timeoutPolicy.wallClockLimitMs,
      });
      const collector = createStreamingJsonlCollector(reporter, () => processActivity);

      reporter?.started();
      const req: ExecRequest = {
        command,
        args,
        cwd,
        timeoutMs: timeoutPolicy.wallClockLimitMs,
        idleTimeoutMs: timeoutPolicy.idleTimeoutMs,
        input: buildPrompt(context, attemptId),
        onSpawn: (pid) => reporter?.spawned(pid),
        onActivityTracker: (activity) => {
          processActivity = activity;
        },
        onStdoutChunk: (chunk) => {
          processArtifact?.appendStdout(chunk);
          reporter?.output('stdout', chunk);
          collector.append(chunk);
        },
        onStderrChunk: (chunk) => {
          processArtifact?.appendStderr(chunk);
          reporter?.output('stderr', chunk);
        },
      };

      const result = await deps.executor(req);
      const processSnapshot = processArtifact.finish({
        code: result.code,
        timedOut: result.timedOut,
        timeoutKind: result.timeoutKind,
        timeoutEvidence: result.timeoutEvidence,
      });

      if (result.timedOut) {
        const err = runnerTimeoutFailure('codex', result, processSnapshot, timeoutPolicy);
        reporter?.failed(err.message, { timedOut: true, exitCode: result.code });
        throw err;
      }
      if (result.code !== 0) {
        const message = `codex runner exited with code ${String(result.code)}: ${tail(result.stderr || result.stdout)}`;
        if (permissionBlockedText(result.stderr) || permissionBlockedText(result.stdout)) {
          reporter?.status('permission_blocked', { preview: tail(result.stderr || result.stdout) });
          throw runnerError(message, processSnapshot);
        }
        reporter?.failed(`codex runner exited with code ${String(result.code)}`, { exitCode: result.code });
        throw runnerError(message, processSnapshot);
      }

      const summary = collector.finish(result.stdout);
      if (summary.failedMessage) {
        const message = `codex runner reported turn.failed: ${tail(summary.failedMessage)}`;
        if (summary.permissionBlocked) {
          reporter?.status('permission_blocked', { preview: tail(summary.failedMessage) });
          throw runnerError(message, processSnapshot);
        }
        reporter?.failed(message, { exitCode: result.code });
        throw runnerError(message, processSnapshot);
      }

      const agent = normalizeCodexResult(summary.finalStructured);
      const costs = buildUsageCosts(step, profile, summary);
      reporter?.finished({ exitCode: result.code, timedOut: result.timedOut });
      return buildAttemptResult(agent, step, costs, processSnapshot);
    } catch (err) {
      if (err instanceof RunAgentError) throw err;
      const processSnapshot = processArtifact?.finish({ error: String(err) });
      reporter?.failed(err);
      throw runnerError(String(err), processSnapshot);
    }
  };
}
