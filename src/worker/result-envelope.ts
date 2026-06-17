import type { Step } from '../control-plane/steps.js';
import type { NewStepSpec } from './runner.js';

// The EXACT contract between the agent and the runner. Two layers:
//   A. transport envelope — `claude -p --output-format json` stdout (final text + cost/usage)
//   B. agent result envelope — a sentineled REVO_RESULT block the agent emits inside that final text
//
// The instruction below is the SINGLE SOURCE OF TRUTH. The runner (claude-code-runner.ts) appends it
// to EVERY prompt so the agent is always told how to emit; the parser here keys on the same markers.
// It lives next to the parser — not in build-context.ts (the stub shares that), not in role prompts.

export const REVO_RESULT_CONTRACT = `
You MUST end your reply with a single result block in EXACTLY this form — the markers on their own lines,
valid JSON between them, and NOTHING after the closing marker:

<<<REVO_RESULT
{
  "verdict": <REQUIRED if your role emits one — EXACTLY one routing token, lowercase, no prose, e.g. "approved" | "changes_requested" | "blocker" | "clean" | "dirty"; the pipeline routes on this. Use null if your role emits no verdict>,
  "output": <any JSON — a short human-readable summary or structured result the next step consumes>,
  "artifacts": <any JSON, optional — e.g. { "planPath": "docs/plans/00xx.md" }; omit if none>,
  "nextSteps": [
    { "role": "developer", "kind": "implement", "input": { "from": "<this step>" },
      "modelProfile"?: "standard", "taskId"?: "<defaults to the current step's task>",
      "priority"?: 0, "maxAttempts"?: 3, "dependsOn"?: [], "runAfter"?: "" }
  ],
  "needsHuman": false,
  "lesson": null
}
REVO_RESULT>>>

If you have no follow-up work, return "nextSteps": []. If you are blocked and need a human, set
"needsHuman": true and "nextSteps": []. Emit the block exactly once.
`;

// Markers the parser keys on — must stay identical to those embedded in REVO_RESULT_CONTRACT.
// The marker-sync unit test guards that invariant.
const OPEN_MARKER = '<<<REVO_RESULT';
const CLOSE_MARKER = 'REVO_RESULT>>>';

// PRIMARY result channel (0016 follow-up): the claude CLI `--json-schema` constrains the agent's final
// message to this schema and returns it as the transport `structured_output` field — a RELIABLE
// `verdict` (the pipeline routes on it), unlike mining a free-text REVO_RESULT block (which the agent
// shaped as prose, leaving no routable verdict). `output` is the summary/plan the next step consumes.
export const AGENT_RESULT_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', description: 'the single routing token, lowercase, e.g. approved | changes_requested | blocker | clean | dirty' },
    output: { type: 'string', description: 'a short summary, or the artifact (e.g. the plan) the next step consumes' },
    needsHuman: { type: 'boolean', description: 'true only if you are blocked and a human must intervene' },
    lesson: { type: 'string', description: 'optional one-line note for a future attempt' },
  },
  required: ['verdict', 'output'],
});

/** Short prompt note paired with `--json-schema` (replaces the prose REVO_RESULT block — the two output
 *  instructions conflict; with --json-schema the CLI returns `structured_output`). */
export const STRUCTURED_RESULT_NOTE = `
Return your final answer as JSON matching the provided output schema:
- "verdict": the single routing token for your role (lowercase; e.g. approved | changes_requested | blocker | clean | dirty).
- "output": a short summary, or — if you produce an artifact for a later step (e.g. an implementation plan) — that artifact.
Set "needsHuman": true only if you are blocked and a human must intervene.
`;

/** Build the AgentResult from a validated structured_output object (the --json-schema path). */
export function agentResultFromStructured(structured: unknown): AgentResult | null {
  if (structured === null || typeof structured !== 'object') return null;
  const o = structured as Record<string, unknown>;
  return {
    output: typeof o.output === 'string' ? o.output : (o.output ?? ''),
    verdict: typeof o.verdict === 'string' && o.verdict.length > 0 ? o.verdict : undefined,
    artifacts: o.artifacts,
    nextSteps: Array.isArray(o.nextSteps) ? o.nextSteps : [],
    needsHuman: Boolean(o.needsHuman),
    lesson: typeof o.lesson === 'string' ? o.lesson : undefined,
  };
}

export type TransportEnvelope = {
  text: string;
  isError: boolean;
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
    costUsd: readNumber(obj.total_cost_usd) ?? readNumber(obj.cost_usd),
    inputTokens: readNumber(usage?.input_tokens),
    outputTokens: readNumber(usage?.output_tokens),
    structuredOutput: obj.structured_output,
  };
}

// Layer B. Extract the substring between the markers and JSON.parse it. Absent or unparseable →
// the documented lesson-bearing error (the corrective is the contract the runner re-appends, not this).
export function extractAgentResult(text: string): AgentResult {
  const start = text.indexOf(OPEN_MARKER);
  const end = start === -1 ? -1 : text.indexOf(CLOSE_MARKER, start + OPEN_MARKER.length);
  if (start === -1 || end === -1) {
    throw new Error('agent did not emit a parseable REVO_RESULT envelope');
  }
  const jsonSlice = text.slice(start + OPEN_MARKER.length, end);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    throw new Error('agent did not emit a parseable REVO_RESULT envelope');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('agent did not emit a parseable REVO_RESULT envelope');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    output: obj.output,
    verdict: typeof obj.verdict === 'string' && obj.verdict.length > 0 ? obj.verdict : undefined,
    artifacts: obj.artifacts,
    nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps : [],
    needsHuman: Boolean(obj.needsHuman),
    lesson: typeof obj.lesson === 'string' ? obj.lesson : undefined,
  };
}

// Map each raw nextSteps entry to NewStepSpec. Require role/kind/input; default taskId and
// modelProfile from the current step so the agent never needs to know IDs. Throw a lesson-bearing
// error (naming the index) on a malformed entry.
export function normalizeNextSteps(raw: unknown[], step: Step): NewStepSpec[] {
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`REVO_RESULT nextSteps[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.role !== 'string' || e.role.length === 0) {
      throw new Error(`REVO_RESULT nextSteps[${i}] missing required "role"`);
    }
    if (typeof e.kind !== 'string' || e.kind.length === 0) {
      throw new Error(`REVO_RESULT nextSteps[${i}] missing required "kind"`);
    }
    if (!('input' in e)) {
      throw new Error(`REVO_RESULT nextSteps[${i}] missing required "input"`);
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
