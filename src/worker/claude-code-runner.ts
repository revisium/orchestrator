import {
  resolveEffectiveRunnerTimeoutPolicy,
  type ProcessExecutor,
  type ExecRequest,
} from './process-executor.js';
import type { RunAgent } from './runner.js';
import { RunAgentError } from './runner.js';
import type { ArtifactStore } from './artifact-store.js';
import type { Step } from '../control-plane/steps.js';
import type { AgentActivityReporter } from '../observability/agent-activity-reporter.js';
import {
  AGENT_RESULT_SCHEMA,
  STRUCTURED_RESULT_NOTE,
  agentResultFromStructured,
  extractTerminalResult,
  parseTransportEnvelope,
  type TransportEnvelope,
} from './result-envelope.js';
import {
  boundedPreview,
  buildAttemptResult,
  buildUsageCosts,
  runnerError,
  runnerTimeoutFailure,
  tail,
} from './runner-common.js';
import { isWorktreeDir } from '../control-plane/resolve-cwd.js';
import type { RunnerActivityTracker } from '../observability/activity-signal.js';


export type ClaudeCodeRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  command?: string;
  artifactStore?: ArtifactStore;
};

const DEFAULT_COMMAND = 'claude';

function hasPermissionDenials(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value === true;
}

function permissionDenialsPreview(transport: TransportEnvelope): string {
  return boundedPreview({ permission_denials: transport.permissionDenials });
}

function hasUsageSummary(transport: TransportEnvelope): boolean {
  return transport.costUsd !== undefined || transport.inputTokens !== undefined || transport.outputTokens !== undefined;
}

function reportTransportMetadata(reporter: AgentActivityReporter | undefined, transport: TransportEnvelope): void {
  if (transport.isError) {
    reporter?.parsed({ type: 'is_error', preview: boundedPreview({ is_error: true }) });
  }
  if (hasUsageSummary(transport)) {
    reporter?.parsed({
      type: 'usage',
      preview: boundedPreview({
        total_cost_usd: transport.costUsd,
        input_tokens: transport.inputTokens,
        output_tokens: transport.outputTokens,
      }),
    });
  }
  if (transport.sessionId) {
    reporter?.parsed({ type: 'session_id', preview: boundedPreview({ session_id: transport.sessionId }) });
  }
  if (transport.terminalReason) {
    reporter?.parsed({
      type: 'terminal_reason',
      preview: boundedPreview({ terminal_reason: transport.terminalReason }),
    });
  }
  if (hasPermissionDenials(transport.permissionDenials)) {
    reporter?.parsed({
      type: 'permission_denials',
      preview: permissionDenialsPreview(transport),
    });
  }
}


function readParamNum(params: unknown, ...keys: string[]): number | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const rec = params as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function streamEventPreview(evt: Record<string, unknown>): string | undefined {
  const message = evt.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    const parts = content.map((raw) => {
      const block = raw as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'tool_use' && typeof block.name === 'string') return `[tool_use:${block.name}]`;
      if (block.type === 'tool_result') return '[tool_result]';
      return `[${String(block.type)}]`;
    });
    const joined = parts.join(' ').trim();
    return joined.length > 0 ? joined.slice(0, 500) : undefined;
  }
  if (typeof evt.result === 'string') return evt.result.slice(0, 500);
  return undefined;
}

function stableStringId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function recordClaudeOperationBlocks(evt: Record<string, unknown>, activity: RunnerActivityTracker | undefined): void {
  const message = evt.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'tool_use') {
      const id = stableStringId(block.id);
      if (id) activity?.operationStarted(id);
      continue;
    }
    if (block.type === 'tool_result') {
      const id = stableStringId(block.tool_use_id);
      if (id) activity?.operationFinished(id);
    }
  }
}

function buildArgs(modelId: string, allowedTools: string[], permissionMode: string, params: unknown): string[] {
  const args = ['-p', '--model', modelId, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode];
  args.push('--json-schema', AGENT_RESULT_SCHEMA);
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }
  const maxTurns = readParamNum(params, 'maxTurns', 'max_turns');
  if (maxTurns !== undefined) {
    args.push('--max-turns', String(Math.trunc(maxTurns)));
  }
  return args;
}

function buildPrompt(context: string, attemptId: string, worktreePath?: string): string {
  const idempotencyLine =
    `Attempt-Id: ${attemptId} — idempotency key. Reference it on any external effect you create.`;
  const parts = [context];
  if (worktreePath) {
    parts.push(
      `Working tree: you are running inside a git worktree at ${worktreePath} ` +
      `(your current working directory, also exported as $REVO_WORKTREE_PATH). ` +
      `Write ALL file changes here; ignore any other repo path.`,
    );
  }
  parts.push(idempotencyLine, STRUCTURED_RESULT_NOTE);
  return parts.join('\n');
}

export function createClaudeCodeRunner(deps: ClaudeCodeRunnerDeps): RunAgent {
  const defaultTimeoutPolicy = resolveEffectiveRunnerTimeoutPolicy({
    idleTimeoutMs: deps.idleTimeoutMs,
    wallClockLimitMs: deps.timeoutMs,
  });
  const command = deps.command ?? DEFAULT_COMMAND;

  return async ({ role, profile, context, attemptId, step, reporter }) => {
    const timeoutPolicy = resolveEffectiveRunnerTimeoutPolicy({
      idleTimeoutMs: defaultTimeoutPolicy.idleTimeoutMs,
      wallClockLimitMs: defaultTimeoutPolicy.wallClockLimitMs,
      roleTimeoutMs: role.timeoutMs,
    });
    const permissionMode = role.permissionMode ?? 'default';
    let processArtifact: ReturnType<ArtifactStore['startProcess']> | undefined;
    let processActivity: RunnerActivityTracker | undefined;
    try {
      const cwd = await deps.resolveCwd(step);
      const liveWorktree = isWorktreeDir(cwd);
      const args = buildArgs(profile.modelId, role.allowedTools, permissionMode, profile.params);
      processArtifact = deps.artifactStore?.startProcess({
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
      reporter?.started();
      let stdoutLineBuffer = '';
      const reportStreamLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed === '') return;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = typeof evt.type === 'string' ? evt.type : 'event';
        processActivity?.markActivity(type === 'heartbeat' ? 'heartbeat' : 'event');
        recordClaudeOperationBlocks(evt, processActivity);
        if (type === 'result') return;
        reporter?.parsed({ type, preview: streamEventPreview(evt) });
      };
      const req: ExecRequest = {
        command,
        args,
        cwd,
        timeoutMs: timeoutPolicy.wallClockLimitMs,
        idleTimeoutMs: timeoutPolicy.idleTimeoutMs,
        input: buildPrompt(context, attemptId, liveWorktree ? cwd : undefined),
        env: liveWorktree ? { REVO_WORKTREE_PATH: cwd } : undefined,
        onSpawn: (pid) => reporter?.spawned(pid),
        onActivityTracker: (activity) => {
          processActivity = activity;
        },
        onStdoutChunk: (chunk) => {
          processArtifact?.appendStdout(chunk);
          stdoutLineBuffer += chunk;
          let nl: number;
          while ((nl = stdoutLineBuffer.indexOf('\n')) >= 0) {
            reportStreamLine(stdoutLineBuffer.slice(0, nl));
            stdoutLineBuffer = stdoutLineBuffer.slice(nl + 1);
          }
        },
        onStderrChunk: (chunk) => {
          processArtifact?.appendStderr(chunk);
          reporter?.output('stderr', chunk);
        },
      };

      const result = await deps.executor(req);
      if (stdoutLineBuffer.trim() !== '') reportStreamLine(stdoutLineBuffer);
      const processSnapshot = processArtifact?.finish({
        code: result.code,
        timedOut: result.timedOut,
        timeoutKind: result.timeoutKind,
        timeoutEvidence: result.timeoutEvidence,
      });

      if (result.timedOut) {
        const err = runnerTimeoutFailure('claude-code', result, processSnapshot, timeoutPolicy);
        reporter?.failed(err.message, { timedOut: true, exitCode: result.code });
        throw err;
      }
      if (result.code !== 0) {
        reporter?.failed(`claude-code runner exited with code ${String(result.code)}`, { exitCode: result.code });
        throw runnerError(
          `claude-code runner exited with code ${String(result.code)}: ${tail(result.stderr || result.stdout)}`,
          processSnapshot,
        );
      }

      const transport = parseTransportEnvelope(extractTerminalResult(result.stdout));
      reporter?.parsed({ type: 'result', preview: transport.text });
      reportTransportMetadata(reporter, transport);
      if (transport.isError) {
        reporter?.failed(`claude-code runner reported is_error: ${tail(transport.text)}`, { exitCode: result.code });
        throw runnerError(`claude-code runner reported is_error: ${tail(transport.text)}`, processSnapshot);
      }

      const agent = agentResultFromStructured(transport.structuredOutput);
      const costs = buildUsageCosts(step, profile, transport);
      const attemptResult = buildAttemptResult(agent, step, costs, processSnapshot);
      reporter?.finished({ exitCode: result.code, timedOut: result.timedOut });
      if (hasPermissionDenials(transport.permissionDenials)) {
        reporter?.status('permission_blocked', { preview: permissionDenialsPreview(transport) });
      }
      return attemptResult;
    } catch (err) {
      if (err instanceof RunAgentError) throw err;
      const processSnapshot = processArtifact?.finish({ error: String(err) });
      reporter?.failed(err);
      throw runnerError(String(err), processSnapshot);
    }
  };
}

