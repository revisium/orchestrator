import type { Step } from '../control-plane/steps.js';
import type { NewStepSpec } from './runner.js';

// The only supported agent result channel: the Claude CLI `--json-schema` constrains the final
// message and returns it as the transport `structured_output` field. The engine routes only on the
// top-level `verdict` from that structured object; prose output is never parsed for routing.
export const AGENT_RESULT_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'string',
      minLength: 1,
      description: 'the single routing token, lowercase, e.g. approved | changes_requested | blocker | clean | dirty',
    },
    output: { type: 'string', description: 'a short summary, or the artifact (e.g. the plan) the next step consumes' },
    artifacts: { description: 'optional JSON artifacts, e.g. { "planPath": "docs/plans/00xx.md" }' },
    nextSteps: {
      type: 'array',
      description: 'optional follow-up work items; use [] when there is no follow-up work',
      items: { type: 'object' },
    },
    needsHuman: { type: 'boolean', description: 'true only if you are blocked and a human must intervene' },
    lesson: { type: 'string', description: 'optional one-line note for a future attempt' },
  },
  required: ['verdict', 'output'],
});

/** Short prompt note paired with `--json-schema`; the CLI returns the result as `structured_output`. */
export const STRUCTURED_RESULT_NOTE = `
Return your final answer as JSON matching the provided output schema:
- "verdict": the single routing token for your role (lowercase; e.g. approved | changes_requested | blocker | clean | dirty).
- "output": a short summary, or — if you produce an artifact for a later step (e.g. an implementation plan) — that artifact.
- "nextSteps": [] unless you are explicitly creating legacy follow-up steps.
Set "needsHuman": true only if you are blocked and a human must intervene.
`;

/** Build the AgentResult from the required structured_output object (the --json-schema path). */
export function agentResultFromStructured(structured: unknown): AgentResult {
  if (structured === undefined) {
    throw new TypeError('agent structured result missing structured_output');
  }
  if (structured === null || typeof structured !== 'object' || Array.isArray(structured)) {
    throw new TypeError('agent structured result must be an object');
  }
  const o = structured as Record<string, unknown>;
  if (typeof o.verdict !== 'string' || o.verdict.trim().length === 0) {
    throw new TypeError('agent structured result missing required top-level verdict');
  }
  if (typeof o.output !== 'string') {
    throw new TypeError('agent structured result missing required string output');
  }
  if ('needsHuman' in o && typeof o.needsHuman !== 'boolean') {
    throw new TypeError('agent structured result needsHuman must be a boolean when present');
  }
  if ('lesson' in o && o.lesson !== null && typeof o.lesson !== 'string') {
    throw new TypeError('agent structured result lesson must be a string when present');
  }
  if ('nextSteps' in o && !Array.isArray(o.nextSteps)) {
    throw new TypeError('agent structured result nextSteps must be an array when present');
  }
  return {
    output: o.output,
    verdict: o.verdict,
    artifacts: o.artifacts,
    nextSteps: Array.isArray(o.nextSteps) ? o.nextSteps : [],
    needsHuman: o.needsHuman === true,
    lesson: typeof o.lesson === 'string' ? o.lesson : undefined,
  };
}

export type TransportEnvelope = {
  text: string;
  isError: boolean;
  permissionDenials?: unknown;
  terminalReason?: string;
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** The `--json-schema`-validated final message (claude CLI `structured_output`), when present. */
  structuredOutput?: unknown;
};

export type AgentResult = {
  output: unknown;
  verdict?: string;
  artifacts?: unknown;
  nextSteps: unknown[];
  needsHuman: boolean;
  lesson?: string;
};

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readFinalText(obj: Record<string, unknown>): string {
  if (typeof obj.result === 'string') return obj.result;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Layer A. Parse defensively; field names are read only inside this module, so a CLI drift is a
// one-file change. Throws only when stdout is not parseable JSON.
export function parseTransportEnvelope(stdout: string): TransportEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('claude -p did not return parseable JSON (transport envelope)');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('claude -p did not return parseable JSON (transport envelope)');
  }
  const obj = parsed as Record<string, unknown>;
  const usage =
    obj.usage !== null && typeof obj.usage === 'object'
      ? (obj.usage as Record<string, unknown>)
      : undefined;
  return {
    text: readFinalText(obj),
    isError: Boolean(obj.is_error),
    permissionDenials: obj.permission_denials,
    terminalReason: readNonEmptyString(obj.terminal_reason),
    sessionId: readNonEmptyString(obj.session_id),
    costUsd: readNumber(obj.total_cost_usd) ?? readNumber(obj.cost_usd),
    inputTokens: readNumber(usage?.input_tokens),
    outputTokens: readNumber(usage?.output_tokens),
    structuredOutput: obj.structured_output,
  };
}

// Map each raw nextSteps entry to NewStepSpec. Require role/kind/input; default taskId and
// modelProfile from the current step so the agent never needs to know IDs. Throw a lesson-bearing
// error (naming the index) on a malformed entry.
export function normalizeNextSteps(raw: unknown[], step: Step): NewStepSpec[] {
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`agent result nextSteps[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.role !== 'string' || e.role.length === 0) {
      throw new Error(`agent result nextSteps[${i}] missing required "role"`);
    }
    if (typeof e.kind !== 'string' || e.kind.length === 0) {
      throw new Error(`agent result nextSteps[${i}] missing required "kind"`);
    }
    if (!('input' in e)) {
      throw new Error(`agent result nextSteps[${i}] missing required "input"`);
    }
    const spec: NewStepSpec = {
      taskId: typeof e.taskId === 'string' && e.taskId.length > 0 ? e.taskId : step.taskId,
      role: e.role,
      kind: e.kind,
      input: e.input,
      modelProfile:
        typeof e.modelProfile === 'string' && e.modelProfile.length > 0
          ? e.modelProfile
          : step.modelProfile,
    };
    if (typeof e.priority === 'number') spec.priority = e.priority;
    if (typeof e.maxAttempts === 'number') spec.maxAttempts = e.maxAttempts;
    if (Array.isArray(e.dependsOn)) spec.dependsOn = e.dependsOn.map(String);
    if (typeof e.runAfter === 'string') spec.runAfter = e.runAfter;
    return spec;
  });
}
