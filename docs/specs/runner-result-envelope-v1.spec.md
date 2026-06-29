# Runner result envelope v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** engine (pipeline), runner adapters (worker)
- **Source files:** `src/worker/result-envelope.ts`, `src/worker/codex-runner.ts`, `src/worker/runner.ts`,
  `src/pipeline/data-driven-task.workflow.ts`
- **Related ADRs:** [ADR-0004](../adr/0004-runner-execution-contract.md), [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md)

## Scope

This spec governs the canonical agent result envelope, the three structured-output tiers
(`native-schema` | `tool-call` | `prompt-only`), the `submit_result` tool-call floor, how the engine harvests the
envelope per tier, and the existing validate seam those tiers ride. It does NOT govern verdict-vocabulary
correctness (the membership of a verdict in a template's domain set — a separate concern, see #207) beyond noting
the boundary.

The manifest envelope and the StdoutParser/PermissionStyle contracts are in
[runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md); the full `capabilities` field list is in
[runner-capabilities-v1.spec.md](./runner-capabilities-v1.spec.md).

Paths are `src/...` = the `@revisium/orchestrator` package root.

## Current Contract

Today there is no tier model — every runner has a native schema flag, and the validate seam is already shipped.
What ships:

- **Two concrete schemas, both native.** Claude: `AGENT_RESULT_SCHEMA` (`src/worker/result-envelope.ts:7-27`) —
  required `['verdict','output']`, `additionalProperties:false`; reconstructed by `agentResultFromStructured`
  (`:39-70`), which lifts `verdict: o.verdict` into the returned result (`:62-69`, copy at `:64`). Codex:
  `CODEX_OUTPUT_SCHEMA` (`src/worker/codex-runner.ts:54-89`) — required
  `['verdict','output','artifacts','nextSteps','needsHuman','lesson']` with nullable fields; validated by
  `validateCodexOutputAgainstSchema` (`:424-478`) and normalized by `normalizeCodexResult` (`:480-496`).
- **The harvested result is an `AttemptResult`** (`src/worker/runner.ts:8-18`) whose only routing-relevant field is
  the top-level `verdict` (`:10-13`).
- **The validate seam is verdict-PRESENCE + verdict-VOCABULARY on AGENT nodes only — NOT a full-envelope schema
  check.** `domainVerdictOf` reads `AttemptResult.verdict`, `.trim().toLowerCase()`
  (`src/pipeline/data-driven-task.workflow.ts:434-440`). `resultVerdictProblem` is gated on `node.kind === 'agent'`
  (early `return undefined` otherwise, `:443`) and checks the verdict is present and a member of
  `template.verdicts.domain` (`:442-452`). `resultSatisfiesSchema` is a **no-op when the node declares no
  `resultSchema`** (early `return true`, `:461`); only when a `resultSchema` is declared does it require a
  non-empty object/string/array output (`:460-467`). `roleValidationFailure` gathers both (`:1241-1256`); a failure
  produces `invalidRoleResult(... REVO_RESULT_INVALID ...)` (`:243`, constant `'revo.ResultInvalid'` at `:240`), a
  terminal `InvokeRoleFailedResult` (`:128-134`, returned at `:1119-1120`).
- **`revo.ResultInvalid` is terminal, not a retry.** It FAILS the node and does NOT re-enter the attempt-retry
  loop. Re-attempting is governed by the separate transient-failure / `needsHuman` machinery
  (`maybeHandleNeedsHumanRoleResult` and the attempt loop's `continue` at `:1110-1117`, the transient retry block
  at `~:1156-1205`; transient classification at `:369-432`), orthogonal to verdict validity.
- **The prompt-only extractor parses whole-string JSON only.** `parseJsonObjectText`
  (`src/worker/codex-runner.ts:205-213`) trims a candidate, requires it to start with `{` and end with `}`, then
  `JSON.parse`s the whole thing — it is NOT a balanced-brace scan over surrounding prose. Text keys are walked by
  `structuredCandidateFromTextKeys` (`:251-259`).

## Target Migration

The target adds a tier capability and a schema-less floor; the validate seam above is unchanged. Current-vs-target:
the seam, the two schemas, and `parseJsonObjectText` are shipped today; the tier model, the `submit_result` tool,
and the degradation rule are the proposal (ADR-0004 is Status: Draft).

### The canonical result envelope

Every runner, regardless of tier, must yield this object — the union (superset) of the two shipped schemas:

```ts
type AgentResultEnvelope = {
  verdict: string;        // the single routing token, lowercase (required)
  output: unknown;        // a short summary, or the artifact a later step consumes (required)
  artifacts?: unknown;    // optional JSON artifacts, e.g. { planPath: "docs/plans/00xx.md" }
  nextSteps: unknown[];   // follow-up work items; [] when none
  needsHuman?: boolean;   // true only when a human must intervene
  lesson?: string;        // optional one-line note for a future attempt
};
```

Claude and Codex differ only in strictness (Codex requires all six keys and allows `null`; Claude requires two and
omits the rest). A runner's `schemaDelivery`/tier decides which concrete schema body is delivered.

#### REQUIRED: lift the envelope `verdict` into `AttemptResult.verdict` for EVERY tier

The `StdoutParser → AttemptResult` mapping MUST copy the envelope's top-level `verdict` into
`AttemptResult.verdict` regardless of tier. This mirrors `agentResultFromStructured`, which lifts `verdict:
o.verdict` (`src/worker/result-envelope.ts:62-69`, copy at `:64`). The whole floor depends on it: the validate seam
reads ONLY `AttemptResult.verdict` (`domainVerdictOf`, `src/pipeline/data-driven-task.workflow.ts:435-440`), so a
parser that harvests the envelope but fails to lift the verdict produces a node that ALWAYS fails to
`revo.ResultInvalid`, no matter how well-formed the envelope was. The parser MUST also normalize the lifted
`verdict` to **lowercase** (the engine does `.trim().toLowerCase()` at `:435-440`). The engine routes ONLY on the
top-level `verdict`; prose output is never mined for routing (`src/worker/result-envelope.ts:5-6`,
`src/pipeline/data-driven-task.workflow.ts:434-440`).

### The three structured-output tiers

`capabilities.supportsStructuredOutput` is a tier, not a boolean. The tier is the mechanism by which a runner
produces the envelope, governing reliability and cost — not eligibility (every runner falls back to `prompt-only`).

- **`native-schema`.** The CLI constrains its final message to a provided JSON schema and returns the validated
  object on a known channel. Claude: `--json-schema <AGENT_RESULT_SCHEMA inline>`
  (`src/worker/claude-code-runner.ts:159`); the validated object arrives as the terminal `result` line's
  `structured_output` (`src/worker/result-envelope.ts:81-82,134`, consumed at `src/worker/claude-code-runner.ts:308`).
  Codex: `--output-schema <file>` (`src/worker/codex-runner.ts:160-161`, file written at `:97-102`); harvested from
  the terminal `turn.completed` event (`:261-269`). Reliability ~100% (provider-enforced).
- **`tool-call`.** The engine registers a `submit_result` tool whose `input_schema` is the envelope; the agent
  calls it and the call's arguments ARE the result. The call is forced via `tool_choice` so the agent cannot end
  the turn without submitting. Shape compliance is **best-effort per provider**: where the provider validates
  tool-call arguments and honors forced `tool_choice`, compliance is high (forcing removes "agent forgot to emit
  JSON"); where a provider ignores forced `tool_choice` / strict tool schemas, this tier **degrades to the
  `prompt-only` floor** (see the degradation rule). No runner is asserted to have a working `tool-call` tier until
  a live probe confirms its provider honors forced tool choice.
- **`prompt-only`.** The prompt asks for JSON matching the envelope; the runner returns free text and the
  StdoutParser extracts the structured object from the final text block. Reliability weakest; leans entirely on the
  verdict-presence validate seam to reject output with no usable verdict. Always available — it is the floor. A
  `prompt-only` parser MAY reuse the shipped whole-string-JSON algorithm (`parseJsonObjectText`,
  `src/worker/codex-runner.ts:205-213`, over the final text block) and MUST then lift + lowercase the `verdict`.

  **Known limitation (whole-string JSON only).** `parseJsonObjectText` requires the candidate to be JSON
  end-to-end (trim, then `startsWith('{') && endsWith('}')`, then `JSON.parse`,
  `src/worker/codex-runner.ts:205-213`) — it REJECTS fenced (```` ```json … ``` ````) or prose-wrapped JSON. So the
  `tool-call` → `prompt-only` degradation can fall straight through to `revo.ResultInvalid` for providers that emit
  fenced JSON, because their final text block does not parse whole-string. **Hardening follow-up:** strip ```` ``` ````
  fences and extract the first balanced JSON object before parsing, so a fenced-JSON provider degrades to a usable
  verdict instead of a hard failure.

### The `submit_result` tool-call contract

For `tool-call`-tier runners, the engine injects exactly one tool:

```jsonc
{
  "name": "submit_result",
  "description": "Submit your final structured result. Call this exactly once, last.",
  "input_schema": { /* the AgentResultEnvelope schema */ },
  "strict": true
}
```

- `name`: `submit_result` (stable; part of the contract).
- `input_schema`: the envelope schema — the same body `native-schema` runners receive via flag.
- Forcing: the engine sets the provider's forced-tool option (the `tool_choice` equivalent) to require
  `submit_result`, so the terminal turn must be this call.
- `strict`: the provider rejects arguments violating the schema (where supported; otherwise the validate seam
  catches drift).

Harvest: the StdoutParser reads the tool-call arguments from the runner's event stream (the `parts-stream` parser
for OpenCode) and returns them as `StdoutParserResult.structured`. The engine then maps `structured` →
`AttemptResult` exactly as the `native-schema` path does.

### Harvest per tier, then validate (the shared seam)

| Tier | Where the envelope comes from | Code today |
|---|---|---|
| `native-schema` | the schema-validated result line/event | `src/worker/claude-code-runner.ts:300-308`; `src/worker/codex-runner.ts:261-269,591` |
| `tool-call` | `submit_result` call arguments | new; harvested by the family's StdoutParser |
| `prompt-only` | whole-string JSON in the final text block | `parseJsonObjectText` (`src/worker/codex-runner.ts:205-213`), tried over text keys by `structuredCandidateFromTextKeys` (`:251-259`) |

After harvest, ALL tiers pass through the same validate seam (the Current Contract seam above). "Prompt-only is a
floor" means a *verdict-presence floor*, not a full-schema guarantee. The tier only changes how often this seam
FAILS a node:

1. Map `structured` → `AttemptResult` (`src/worker/runner.ts:8-18`), lifting + lowercasing `verdict`.
2. `resultVerdictProblem` — gated on `node.kind === 'agent'`; the top-level verdict must be present and a member of
   `template.verdicts.domain` (`src/pipeline/data-driven-task.workflow.ts:442-452`, source `domainVerdictOf`,
   `:434-440`).
3. `resultSatisfiesSchema` — a no-op when the node declares no `resultSchema` (`:461`); otherwise requires a
   non-empty output (`:460-467`).
4. `roleValidationFailure` gathers (2)+(3) (`:1241-1256`); a failure → `revo.ResultInvalid` (`:240,243`), a
   terminal `InvokeRoleFailedResult` (`:128-134`, returned at `:1119-1120`).

`revo.ResultInvalid` is a TERMINAL failure signal — it does NOT re-enter the attempt-retry loop (retries are the
transient/`needsHuman` machinery's job, see Current Contract). So "a lower tier fires the validate seam more often"
means "produces more `revo.ResultInvalid` *terminal* failed-nodes," not "triggers more retries." Routing may
require a minimum tier to keep this failure rate low.

### Tier-degradation rule for `tool-call` (no silent failure)

A `tool-call` runner's provider may ignore forced `tool_choice` / strict tool schemas, so the engine MUST NOT treat
a missing `submit_result` call as an immediate hard failure. The degradation order WITHIN a single attempt:

1. If a `submit_result` tool call arrives, harvest its arguments as `structured` (the `native-schema`-equivalent
   path) and validate.
2. If NO `submit_result` call arrives, fall back to `prompt-only` extraction of the final text block (the
   whole-string-JSON algorithm): parse, lift + lowercase the `verdict`, validate.
3. Only if step 2 ALSO yields no valid verdict does the node fail to `revo.ResultInvalid`.

This is the explicit answer to "what happens when forcing isn't honored": a deterministic fall-through to the
floor, not a silent failure and not an unconditional `revo.ResultInvalid`. The fall-through is per-attempt and
inside the parser/harvest seam; it does not by itself trigger a retry. (See the known fenced-JSON limitation above:
step 2 can still fail for providers that emit fenced JSON until the hardening follow-up lands.)

### Shape vs. vocabulary (boundary with #207)

A schema (any tier) guarantees the result's SHAPE — `verdict` is a non-empty string, `output` is present, etc. It
does NOT guarantee the verdict is a VALID token for the role/template. Vocabulary correctness is a separate check —
`resultVerdictProblem`'s membership test against `template.verdicts.domain`
(`src/pipeline/data-driven-task.workflow.ts:448-450`) — and the broader verdict-vocabulary work is tracked under
#207. Tiers improve shape compliance; they do not improve vocabulary correctness.

## Validation

- **Verdict-lift test per parser.** Each `stdoutParser` has a test proving it lifts + lowercases the envelope
  `verdict` into `AttemptResult.verdict`; a parser that harvests but fails to lift is caught here.
- **Tier-degradation test.** A `tool-call` runner whose provider drops the forced call falls through to
  `prompt-only` extraction within the same attempt, and only a no-usable-verdict result reaches `revo.ResultInvalid`.
- **Fenced-JSON limitation test (regression marker).** A test asserts the current `prompt-only` extractor rejects
  fenced/prose-wrapped JSON; once the hardening follow-up lands, the same fixtures must yield a usable verdict.
- **Validate-seam invariance.** The verdict-presence + vocabulary seam behaves identically across all three tiers;
  only the harvest source differs.

## Compatibility

The `submit_result` tool name and its `input_schema` (the envelope) are a public contract once a `tool-call` runner
ships. A schema-changing revision follows the same id discipline as the code strategies (see
[runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md) Compatibility). The shipped validate seam is unchanged
by the tier model, so existing `native-schema` runners are unaffected. This spec refines the
[runner contract](../runner-contract.md) without contradicting it.

## Examples

A `tool-call` runner attempt that degrades to the floor:

```jsonc
// provider ignored forced tool_choice → no submit_result call in the stream
// engine falls back to prompt-only over the final text block:
"{ \"verdict\": \"approved\", \"output\": \"…\", \"nextSteps\": [] }"
// parseJsonObjectText parses (whole-string JSON), verdict lifted + lowercased → "approved" → validate seam passes.

// but if the provider emitted fenced JSON:
"```json\n{ \"verdict\": \"approved\" }\n```"
// parseJsonObjectText rejects (does not start with '{'), no usable verdict → revo.ResultInvalid (known limitation).
```

## Changelog

- 2026-06-29: Initial version.
