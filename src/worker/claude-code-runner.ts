import type { ProcessExecutor, ExecRequest } from './process-executor.js';
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
import { boundedPreview, buildAttemptResult, buildUsageCosts, runnerError, tail } from './runner-common.js';
import { isWorktreeDir } from '../control-plane/resolve-cwd.js';

// The ONE place Claude Code CLI specifics live. The runner hides the protocol entirely: the loop sees
// only the RunAgent interface. Process spawning goes through an injected ProcessExecutor (the
// testability seam), so unit tests run a fake — no real `claude`, no tokens.

export type ClaudeCodeRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>; // worktree-aware (plan 0017): the run's isolated worktree for live runs
  timeoutMs?: number; // default 10 min
  command?: string; // default 'claude'
  artifactStore?: ArtifactStore;
};

const DEFAULT_TIMEOUT_MS = 600_000;
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

/** Read a positive number from a parsed model_profiles.params object, trying camel + snake keys. */
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

// Summarize one stream-json event into a short, redaction-safe preview for the observability feed.
// Assistant turns surface their text + tool names; tool results are marked; anything else by type.
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

// CLI invocation — the only place flags are assembled. EXACT flag set is confirmed by the manual
// Step-6 smoke before --runner defaults to auto. The permission mode keeps the headless run
// non-interactive: a tool not in allowedTools is auto-denied (no TTY can prompt in -p mode).
// 0008 #5: permissionMode is now per-role DATA (was hardcoded 'default'); model_profiles.params
// (previously unused "{}") is threaded in — a configured maxTurns maps to claude's --max-turns.
function buildArgs(modelId: string, allowedTools: string[], permissionMode: string, params: unknown): string[] {
  // stream-json (NOT json): claude emits a JSONL transcript — one event per turn (assistant text,
  // tool_use, tool_result) plus a terminal `result` line — so the runner can stream live per-turn
  // observability AND still extract the final structured result. `--verbose` is required by claude
  // for stream-json in `-p` mode. Confirmed by experiment before this change (slice 128).
  const args = ['-p', '--model', modelId, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode];
  // Constrain the final message to the agent-result schema -> a reliable `verdict` in structured_output.
  // No prose fallback is accepted.
  args.push('--json-schema', AGENT_RESULT_SCHEMA);
  // Empty list → pass NO tools (most restrictive; text/plan-only). Never widen beyond role.allowedTools.
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }
  const maxTurns = readParamNum(params, 'maxTurns', 'max_turns');
  if (maxTurns !== undefined) {
    args.push('--max-turns', String(Math.trunc(maxTurns)));
  }
  return args;
}

// Prompt order (design decision 6): context → [worktree note] → attemptId line → structured-result note.
// Appending the output instruction here keeps the result contract transport-owned, not buried in role prompts.
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
  const fallbackTimeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = deps.command ?? DEFAULT_COMMAND;

  return async ({ role, profile, context, attemptId, step, reporter }) => {
    // attemptId is already minted by startAttempt (loop) — consumed here, never re-minted.
    // cwd is worktree-aware (plan 0017): for a live run, resolveCwd returns the run's isolated worktree
    // (keyed by step.runId); per-run worktree lifecycle is owned by the workflow, NOT the runner.
    // 0008 #5: per-role data overrides the hardcoded defaults (timeout + permission mode).
    const timeoutMs = role.timeoutMs ?? fallbackTimeoutMs;
    const permissionMode = role.permissionMode ?? 'default';
    let processArtifact: ReturnType<ArtifactStore['startProcess']> | undefined;
    try {
      const cwd = await deps.resolveCwd(step);
      // Belt-and-suspenders: detect if we are running inside a git worktree (linked worktree's .git is a
      // FILE, not a dir) and export REVO_WORKTREE_PATH + a prompt note so agents that read env rather
      // than the Repo: context line still write to the correct tree (slice 143 follow-up).
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
        timeoutMs,
      });
      reporter?.started();
      // stream-json arrives as JSONL; buffer partial chunks and report ONE observability event per
      // COMPLETE line — this is the live per-turn transcript. The terminal `result` line is skipped
      // here and reported below via reportTransportMetadata (after extraction), to avoid duplication.
      let stdoutLineBuffer = '';
      const reportStreamLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed === '') return;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // a partial or non-JSON line — ignore
        }
        const type = typeof evt.type === 'string' ? evt.type : 'event';
        if (type === 'result') return;
        reporter?.parsed({ type, preview: streamEventPreview(evt) });
      };
      const req: ExecRequest = {
        command,
        args,
        cwd,
        timeoutMs,
        input: buildPrompt(context, attemptId, liveWorktree ? cwd : undefined),
        env: liveWorktree ? { REVO_WORKTREE_PATH: cwd } : undefined,
        onSpawn: (pid) => reporter?.spawned(pid),
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
      // Flush a trailing partial line (the result line normally ends in \n, so this is usually empty).
      if (stdoutLineBuffer.trim() !== '') reportStreamLine(stdoutLineBuffer);
      const processSnapshot = processArtifact?.finish({ code: result.code, timedOut: result.timedOut });

      // Timeout / process failure → throw; the loop's catch → failStep returns the step to ready
      // (backoff) or dead at the attempt cap. No loop change needed.
      if (result.timedOut) {
        reporter?.failed(`claude-code runner exceeded ${timeoutMs}ms`, { timedOut: true, exitCode: result.code });
        throw runnerError(`claude-code runner exceeded ${timeoutMs}ms`, processSnapshot);
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

// Idempotency seam (this slice does NO external create): attemptId is minted before the run and
// threaded into the prompt so artifacts/effects can reference it. The "create-only-if-key-unused"
// guard for real commits/PRs is Plan 0011 — the runner itself performs no external write.
