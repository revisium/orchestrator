import type { ProcessExecutor, ExecRequest } from './process-executor.js';
import type { RunAgent, AttemptResult } from './runner.js';
import type { Step, CostRecord } from '../control-plane/steps.js';
import type { ModelProfile } from '../control-plane/definitions.js';
import {
  REVO_RESULT_CONTRACT,
  parseTransportEnvelope,
  extractAgentResult,
  normalizeNextSteps,
  type TransportEnvelope,
} from './result-envelope.js';

// The ONE place Claude Code CLI specifics live. The runner hides the protocol entirely: the loop sees
// only the RunAgent interface. Process spawning goes through an injected ProcessExecutor (the
// testability seam), so unit tests run a fake — no real `claude`, no tokens.

export type ClaudeCodeRunnerDeps = {
  executor: ProcessExecutor;
  resolveCwd: (step: Step) => Promise<string>; // injected; the default (reads task repo_ref) is wired in revo work
  timeoutMs?: number; // default 10 min
  command?: string; // default 'claude'
};

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_COMMAND = 'claude';
const ERROR_TAIL = 2_000;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ERROR_TAIL ? trimmed.slice(-ERROR_TAIL) : trimmed;
}

// CLI invocation — the only place flags are assembled. EXACT flag set is confirmed by the manual
// Step-6 smoke before --runner defaults to auto. `--permission-mode default` keeps the headless run
// non-interactive: a tool not in allowedTools is auto-denied (no TTY can prompt in -p mode).
function buildArgs(modelId: string, allowedTools: string[]): string[] {
  const args = ['-p', '--model', modelId, '--output-format', 'json', '--permission-mode', 'default'];
  // Empty list → pass NO tools (most restrictive; text/plan-only). Never widen beyond role.allowedTools.
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }
  return args;
}

// Prompt order (design decision 6): context → attemptId line → REVO_RESULT_CONTRACT. Appending the
// contract HERE — not in build-context.ts, not in the role system_prompt — guarantees the agent is
// told how to emit on EVERY attempt, including retries.
function buildPrompt(context: string, attemptId: string): string {
  const idempotencyLine =
    `Attempt-Id: ${attemptId} — idempotency key. Reference it on any external effect you create.`;
  return [context, idempotencyLine, REVO_RESULT_CONTRACT].join('\n');
}

// One CostRecord from the transport envelope. Prefer the CLI-reported USD; else compute from tokens.
// Zero tokens with no reported cost → empty costs (keeps zero-cost paths truly free).
function buildCosts(step: Step, profile: ModelProfile, env: TransportEnvelope): CostRecord[] {
  const inputTokens = env.inputTokens ?? 0;
  const outputTokens = env.outputTokens ?? 0;
  const reportedUsd = (typeof env.costUsd === 'number' && Number.isFinite(env.costUsd)) ? env.costUsd : undefined;
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

export function createClaudeCodeRunner(deps: ClaudeCodeRunnerDeps): RunAgent {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = deps.command ?? DEFAULT_COMMAND;

  return async ({ role, profile, context, attemptId, step }) => {
    // attemptId is already minted by startAttempt (loop) — consumed here, never re-minted.
    const cwd = await deps.resolveCwd(step);
    const req: ExecRequest = {
      command,
      args: buildArgs(profile.modelId, role.allowedTools),
      cwd,
      timeoutMs,
      input: buildPrompt(context, attemptId),
    };

    const result = await deps.executor(req);

    // Timeout / process failure → throw; the loop's catch → failStep returns the step to ready
    // (backoff) or dead at the attempt cap. No loop change needed.
    if (result.timedOut) {
      throw new Error(`claude-code runner exceeded ${timeoutMs}ms`);
    }
    if (result.code !== 0) {
      throw new Error(
        `claude-code runner exited with code ${String(result.code)}: ${tail(result.stderr || result.stdout)}`,
      );
    }

    const transport = parseTransportEnvelope(result.stdout);
    if (transport.isError) {
      throw new Error(`claude-code runner reported is_error: ${tail(transport.text)}`);
    }

    const agent = extractAgentResult(transport.text);
    const costs = buildCosts(step, profile, transport);

    // needsHuman: do NOT write nextSteps — the loop parks via the existing awaiting_approval path.
    if (agent.needsHuman) {
      const parked: AttemptResult = {
        output: agent.output,
        nextSteps: [],
        costs,
        needsHuman: true,
        lesson: agent.lesson,
      };
      return parked;
    }

    const success: AttemptResult = {
      output: agent.output,
      artifacts: agent.artifacts,
      nextSteps: normalizeNextSteps(agent.nextSteps, step),
      costs,
      needsHuman: false,
      lesson: agent.lesson,
    };
    return success;
  };
}

// Idempotency seam (this slice does NO external create): attemptId is minted before the run and
// threaded into the prompt so artifacts/effects can reference it. The "create-only-if-key-unused"
// guard for real commits/PRs is Plan 0011 — the runner itself performs no external write.
