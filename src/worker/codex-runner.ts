import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ModelProfile, Role } from '../control-plane/definitions.js';
import type { CostRecord, Step } from '../control-plane/steps.js';
import type { AgentActivityReporter } from '../observability/agent-activity-reporter.js';
import type { ArtifactStore, ProcessArtifactSnapshot } from './artifact-store.js';
import type { ExecRequest, ProcessExecutor } from './process-executor.js';
import type { AttemptResult, NewStepSpec, RunAgent } from './runner.js';
import { RunAgentError } from './runner.js';
import { normalizeNextSteps } from './result-envelope.js';

export type CodexRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>;
  artifactStore: ArtifactStore;
  timeoutMs?: number;
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

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_COMMAND = 'codex';
const ERROR_TAIL = 2_000;
const OBSERVABILITY_PREVIEW_MAX_CHARS = 1_000;
const OBSERVABILITY_ARRAY_MAX_ITEMS = 5;
const OBSERVABILITY_OBJECT_MAX_KEYS = 12;
const OBSERVABILITY_STRING_MAX_CHARS = 120;

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

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ERROR_TAIL ? trimmed.slice(-ERROR_TAIL) : trimmed;
}

function boundedString(value: string, maxChars = OBSERVABILITY_STRING_MAX_CHARS): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function boundedPreviewValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '[object]';
  if (Array.isArray(value)) {
    const limited = value.slice(0, OBSERVABILITY_ARRAY_MAX_ITEMS).map((entry) => boundedPreviewValue(entry, depth + 1));
    if (value.length > OBSERVABILITY_ARRAY_MAX_ITEMS) {
      limited.push(`[${value.length - OBSERVABILITY_ARRAY_MAX_ITEMS} more]`);
    }
    return limited;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, OBSERVABILITY_OBJECT_MAX_KEYS);
    for (const [key, entry] of entries) out[key] = boundedPreviewValue(entry, depth + 1);
    const keyCount = Object.keys(value).length;
    if (keyCount > OBSERVABILITY_OBJECT_MAX_KEYS) out._truncatedKeys = keyCount - OBSERVABILITY_OBJECT_MAX_KEYS;
    return out;
  }
  return `[${typeof value}]`;
}

function boundedPreview(value: unknown): string {
  const preview = JSON.stringify(boundedPreviewValue(value));
  return preview.length > OBSERVABILITY_PREVIEW_MAX_CHARS
    ? `${preview.slice(0, OBSERVABILITY_PREVIEW_MAX_CHARS)}...`
    : preview;
}

function withProcessArtifact(agentArtifacts: unknown, process: ProcessArtifactSnapshot | undefined): unknown {
  if (!process) return agentArtifacts;
  const processEntry = {
    ref: process.ref,
    stdoutTail: process.stdoutTail,
    stderrTail: process.stderrTail,
  };
  if (agentArtifacts && typeof agentArtifacts === 'object' && !Array.isArray(agentArtifacts)) {
    return { ...agentArtifacts, process: processEntry };
  }
  return { agent: agentArtifacts ?? null, process: processEntry };
}

function runnerError(message: string, process: ProcessArtifactSnapshot | undefined): RunAgentError {
  return new RunAgentError(message, withProcessArtifact(undefined, process));
}

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
  return (value ?? '').trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, ' ');
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

function structuredCandidateFromTerminalEvent(event: Record<string, unknown>): unknown {
  if (event.type !== 'turn.completed') return undefined;

  const directKeys = ['structured_output', 'structuredOutput', 'final_output', 'finalOutput'];
  for (const key of directKeys) {
    if (isStructuredCandidate(event[key])) return event[key];
  }
  if (isStructuredCandidate(event.output)) return event.output;
  if (isStructuredCandidate(event.result)) return event.result;

  const item = maybeObject(event.item);
  if (item) {
    if (isStructuredCandidate(item.output)) return item.output;
    const contentCandidate = candidateFromContentArray(item.content);
    if (isStructuredCandidate(contentCandidate)) return contentCandidate;
  }

  const message = maybeObject(event.message);
  if (message) {
    if (isStructuredCandidate(message.output)) return message.output;
    const contentCandidate = candidateFromContentArray(message.content);
    if (isStructuredCandidate(contentCandidate)) return contentCandidate;
  }

  const textKeys = ['output_text', 'text', 'result'];
  for (const key of textKeys) {
    const value = readString(event[key]);
    if (!value) continue;
    const parsed = parseJsonObjectText(value);
    if (isStructuredCandidate(parsed)) return parsed;
  }

  return undefined;
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

function parseCodexJsonl(stdout: string, reporter?: AgentActivityReporter): CodexJsonlSummary {
  const summary: CodexJsonlSummary = { permissionBlocked: false };
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('codex exec did not return JSONL events');

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`codex exec returned malformed JSONL at line ${index + 1}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`codex exec returned non-object JSONL at line ${index + 1}`);
    }
    const event = parsed as Record<string, unknown>;
    reporter?.parsed({ type: readString(event.type) ?? 'event', preview: boundedPreview(event) });

    const usage = usageFromEvent(event);
    summary.costUsd = usage.costUsd ?? summary.costUsd;
    summary.inputTokens = usage.inputTokens ?? summary.inputTokens;
    summary.outputTokens = usage.outputTokens ?? summary.outputTokens;

    const failure = eventFailureMessage(event);
    if (failure) {
      summary.failedMessage = failure;
      summary.permissionBlocked ||= permissionBlockedText(event);
    }
    const structured = structuredCandidateFromTerminalEvent(event);
    if (structured !== undefined) summary.finalStructured = structured;
  }
  return summary;
}

function createStreamingJsonlCollector(reporter?: AgentActivityReporter): {
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
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('non-object JSONL event');
      }
      const event = parsed as Record<string, unknown>;
      parsedEvents.push(event);
      reporter?.parsed({ type: readString(event.type) ?? 'event', preview: boundedPreview(event) });
    } catch {
      parseError = new Error(`codex exec returned malformed JSONL at line ${parsedEvents.length + 1}`);
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
      if (received.length === 0) return parseCodexJsonl(fallbackStdout, reporter);
      parseLine(buffered);
      if (parseError) throw parseError;
      const summary: CodexJsonlSummary = { permissionBlocked: false };
      if (parsedEvents.length === 0) throw new Error('codex exec did not return JSONL events');
      for (const event of parsedEvents) {
        const usage = usageFromEvent(event);
        summary.costUsd = usage.costUsd ?? summary.costUsd;
        summary.inputTokens = usage.inputTokens ?? summary.inputTokens;
        summary.outputTokens = usage.outputTokens ?? summary.outputTokens;
        const failure = eventFailureMessage(event);
        if (failure) {
          summary.failedMessage = failure;
          summary.permissionBlocked ||= permissionBlockedText(event);
        }
        const structured = structuredCandidateFromTerminalEvent(event);
        if (structured !== undefined) summary.finalStructured = structured;
      }
      return summary;
    },
  };
}

type SchemaValidationIssue = {
  path: string;
  message: string;
};

function validateCodexOutputAgainstSchema(value: unknown): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ path: '$', message: 'must be an object' }];
  }

  const obj = value as Record<string, unknown>;
  const required = CODEX_OUTPUT_SCHEMA.required;
  const allowed = new Set(Object.keys(CODEX_OUTPUT_SCHEMA.properties));

  for (const key of required) {
    if (!(key in obj)) issues.push({ path: `$.${key}`, message: 'is required' });
  }

  if (CODEX_OUTPUT_SCHEMA.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) issues.push({ path: `$.${key}`, message: 'is not allowed by schema' });
    }
  }

  if ('verdict' in obj && (typeof obj.verdict !== 'string' || obj.verdict.trim().length === 0)) {
    issues.push({ path: '$.verdict', message: 'must be a non-empty string' });
  }
  if ('nextSteps' in obj && obj.nextSteps !== null && !Array.isArray(obj.nextSteps)) {
    issues.push({ path: '$.nextSteps', message: 'must be an array or null' });
  }
  if (Array.isArray(obj.nextSteps)) {
    for (const [index, entry] of obj.nextSteps.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.push({ path: `$.nextSteps[${index}]`, message: 'must be an object' });
      }
    }
  }
  if ('needsHuman' in obj && obj.needsHuman !== null && typeof obj.needsHuman !== 'boolean') {
    issues.push({ path: '$.needsHuman', message: 'must be a boolean or null' });
  }
  if ('lesson' in obj && obj.lesson !== null && typeof obj.lesson !== 'string') {
    issues.push({ path: '$.lesson', message: 'must be a string or null' });
  }

  return issues;
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

function buildCosts(step: Step, profile: ModelProfile, summary: CodexJsonlSummary): CostRecord[] {
  const inputTokens = summary.inputTokens ?? 0;
  const outputTokens = summary.outputTokens ?? 0;
  const reportedUsd = typeof summary.costUsd === 'number' && Number.isFinite(summary.costUsd) ? summary.costUsd : undefined;
  if (inputTokens === 0 && outputTokens === 0 && reportedUsd === undefined) return [];
  const computed =
    (inputTokens / 1_000_000) * profile.costPerInput +
    (outputTokens / 1_000_000) * profile.costPerOutput;
  return [
    {
      modelProfile: step.modelProfile,
      inputTokens,
      outputTokens,
      costAmount: reportedUsd ?? computed,
      currency: 'USD',
    },
  ];
}

function successResult(
  agent: CodexAgentResult,
  step: Step,
  costs: CostRecord[],
  processSnapshot: ProcessArtifactSnapshot | undefined,
): AttemptResult {
  if (agent.needsHuman) {
    return {
      output: agent.output,
      verdict: agent.verdict,
      artifacts: withProcessArtifact(agent.artifacts, processSnapshot),
      nextSteps: [],
      costs,
      needsHuman: true,
      lesson: agent.lesson,
    };
  }
  const nextSteps: NewStepSpec[] = normalizeNextSteps(agent.nextSteps, step);
  return {
    output: agent.output,
    verdict: agent.verdict,
    artifacts: withProcessArtifact(agent.artifacts, processSnapshot),
    nextSteps,
    costs,
    needsHuman: false,
    lesson: agent.lesson,
  };
}

export function createCodexRunner(deps: CodexRunnerDeps): RunAgent {
  const fallbackTimeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = deps.command ?? DEFAULT_COMMAND;

  return async ({ role, profile, context, attemptId, step, reporter }) => {
    let processArtifact: ReturnType<ArtifactStore['startProcess']> | undefined;
    try {
      requireCompatibleProfile(profile);
      const timeoutMs = role.timeoutMs ?? fallbackTimeoutMs;
      const cwd = await deps.resolveCwd(step);
      const sandbox = sandboxForRole(role);
      const schemaPath = writeCodexOutputSchema(deps.artifactStore.resolveAttemptDir(step.runId, attemptId));
      const args = buildArgs(profile.modelId, sandbox, cwd, schemaPath);
      processArtifact = deps.artifactStore.startProcess({
        runId: step.runId,
        attemptId,
        stepId: step.id,
        role: role.name,
        command,
        args,
        cwd,
        timeoutMs,
      });
      const collector = createStreamingJsonlCollector(reporter);

      reporter?.started();
      const req: ExecRequest = {
        command,
        args,
        cwd,
        timeoutMs,
        input: buildPrompt(context, attemptId),
        onSpawn: (pid) => reporter?.spawned(pid),
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
      const processSnapshot = processArtifact.finish({ code: result.code, timedOut: result.timedOut });

      if (result.timedOut) {
        reporter?.failed(`codex runner exceeded ${timeoutMs}ms`, { timedOut: true, exitCode: result.code });
        throw runnerError(`codex runner exceeded ${timeoutMs}ms`, processSnapshot);
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
      const costs = buildCosts(step, profile, summary);
      reporter?.finished({ exitCode: result.code, timedOut: result.timedOut });
      return successResult(agent, step, costs, processSnapshot);
    } catch (err) {
      if (err instanceof RunAgentError) throw err;
      const processSnapshot = processArtifact?.finish({ error: String(err) });
      reporter?.failed(err);
      throw runnerError(String(err), processSnapshot);
    }
  };
}
