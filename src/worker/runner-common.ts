import type { ModelProfile } from '../control-plane/definitions.js';
import type { CostRecord, Step } from '../control-plane/steps.js';
import type { ProcessArtifactSnapshot } from './artifact-store.js';
import type { AttemptResult } from './runner.js';
import { RunAgentError } from './runner.js';
import { normalizeNextSteps } from './result-envelope.js';

const ERROR_TAIL = 2_000;
const OBSERVABILITY_PREVIEW_MAX_CHARS = 1_000;
const OBSERVABILITY_ARRAY_MAX_ITEMS = 5;
const OBSERVABILITY_OBJECT_MAX_KEYS = 12;
const OBSERVABILITY_STRING_MAX_CHARS = 120;

export type UsageSummary = {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type AgentAttemptResult = {
  output: unknown;
  verdict?: string;
  artifacts?: unknown;
  nextSteps: unknown[];
  needsHuman: boolean;
  lesson?: string;
};

export function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ERROR_TAIL ? trimmed.slice(-ERROR_TAIL) : trimmed;
}

function boundedString(value: string, maxChars = OBSERVABILITY_STRING_MAX_CHARS): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

export function boundedPreviewValue(value: unknown, depth = 0): unknown {
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

export function boundedPreview(value: unknown): string {
  const preview = JSON.stringify(boundedPreviewValue(value));
  return preview.length > OBSERVABILITY_PREVIEW_MAX_CHARS
    ? `${preview.slice(0, OBSERVABILITY_PREVIEW_MAX_CHARS)}...`
    : preview;
}

export function withProcessArtifact(agentArtifacts: unknown, process: ProcessArtifactSnapshot | undefined): unknown {
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

export function runnerError(message: string, process: ProcessArtifactSnapshot | undefined): RunAgentError {
  return new RunAgentError(message, withProcessArtifact(undefined, process));
}

export function buildUsageCosts(step: Step, profile: ModelProfile, usage: UsageSummary): CostRecord[] {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const reportedUsd = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : undefined;
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

export function buildAttemptResult(
  agent: AgentAttemptResult,
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
  return {
    output: agent.output,
    verdict: agent.verdict,
    artifacts: withProcessArtifact(agent.artifacts, processSnapshot),
    nextSteps: normalizeNextSteps(agent.nextSteps, step),
    costs,
    needsHuman: false,
    lesson: agent.lesson,
  };
}
