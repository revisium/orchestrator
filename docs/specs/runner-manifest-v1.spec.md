# Runner manifest v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** engine (pipeline), runner adapters (worker)
- **Source files:** `src/pipeline/route-contract.ts`, `src/worker/runner-dispatch.ts`,
  `src/worker/claude-code-runner.ts`, `src/worker/codex-runner.ts`, `src/worker/process-executor.ts`,
  `src/control-plane/definitions.ts`, `src/pipeline/data-driven-task.workflow.ts`
- **Related ADRs:** [ADR-0004](../adr/0004-runner-execution-contract.md), [ADR-0002](../adr/0002-data-driven-pipeline-state-machine.md)

## Scope

This spec governs the runner manifest field schema and the two code system-entity contracts a manifest binds to:
`StdoutParser` and `PermissionStyle`. It also pins the route-time snapshot that keeps capability resolution
deterministic across DBOS replay and recovery.

It does NOT govern selection (which runner a role resolves to, execution profiles) or manifest persistence/loading
— those are the registry decision (#169 / #170 / #186, a future selection ADR). The result-envelope schema and the
structured-output tiers are in [runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md); the full
`capabilities` field list is in [runner-capabilities-v1.spec.md](./runner-capabilities-v1.spec.md).

Paths are `src/...` = the `@revisium/orchestrator` package root.

## Current Contract

Today there is no manifest. Runner facts are hardcoded in the engine and the two adapters. The shipped behavior
this spec relocates:

- **Dispatch is a literal switch.** `dispatchRunnerId(runnerId)` rewrites ids (`'stub-agent'`→`'script'`;
  `'claude-code'`/`'codex'`/`'script'` pass through; `'revo-'` prefix→`'script'`; else identity) at
  `src/pipeline/route-contract.ts:110-114`, and the `RunAgent` factory `switch (args.role.runner)` enumerates
  `'claude-code'`, `'codex'`, `'script'`, `'stub-agent'` and throws `RUNNER_NOT_IMPLEMENTED` otherwise
  (`src/worker/runner-dispatch.ts:8-20`).
- **The default runner is a literal.** A role row with no `runner_id`/`runner` defaults to `'claude-code'` in
  `loadRole` (`src/control-plane/definitions.ts:112`).
- **argv is assembled in code, per adapter.** Claude: `buildArgs` emits `-p --model … --output-format stream-json
  --verbose --permission-mode <mode> --json-schema <inline JSON> --allowedTools <comma list>`
  (`src/worker/claude-code-runner.ts:151-169`), prompt on stdin (`src/worker/claude-code-runner.ts:254`). Codex:
  `exec --json --output-schema <file path> -c approval_policy="never" --model … --sandbox <enum> --cd <cwd> … -`
  (`src/worker/codex-runner.ts:157-177`), schema file written at `src/worker/codex-runner.ts:97-102`, prompt on
  stdin with a trailing `-` terminator (`src/worker/codex-runner.ts:175`, `:541`).
- **`--allowedTools` is dropped when empty.** Claude pushes the flag pair only when `role.allowedTools` is
  non-empty (`src/worker/claude-code-runner.ts:161-163`); Codex joins identically
  (`src/worker/codex-runner.ts:161-163`).
- **Provider compatibility is a hard throw.** Codex rejects a non-OpenAI-compatible provider via
  `requireCompatibleProfile` (`src/worker/codex-runner.ts:179-186`, `isOpenAiCompatibleProvider` at `:109-112`),
  and guards a non-empty model id at `:180-182`.
- **Rights→sandbox is a hardcoded table.** `sandboxForRole` collapses `role.rights` + `role.allowedTools` to
  `read-only`/`workspace-write` via `WRITE_TOOL_NAMES`, `READ_ONLY_RIGHTS`, `WORKSPACE_WRITE_RIGHTS`
  (`src/worker/codex-runner.ts:114-155`), throwing on an unmapped non-empty label (`:151-153`).
- **The spawn primitive is already generic.** `ExecRequest` is runner-agnostic
  (`src/worker/process-executor.ts:12-24`) and is unchanged by this spec. Engine timeout defaults are
  `DEFAULT_RUNNER_IDLE_TIMEOUT_MS` / `DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS` (`src/worker/process-executor.ts:32-33`);
  the role `timeoutMs` override path is `src/control-plane/definitions.ts:18-19`,
  `src/worker/claude-code-runner.ts:200-204`.
- **The route binding shape today** is `RouteRoleBinding =
  {roleId, rowId, modelLevel, runnerId, resolvedRunnerId, runnerSource}` (`src/pipeline/route-contract.ts:9-16`).
  It carries no capability snapshot.

## Target Migration

A manifest moves the data parts out of code, keeps the irreducibly-code parts as referenced strategy ids, and pins
the resolution for replay. The current-vs-target distinction: **Current Contract** above is the hardcoded reality
that ships today; everything below is the proposed model (ADR-0004 is Status: Draft).

### Two kinds of identifier

- **Code-referenced ids** — strings naming a code strategy in a closed registry: the `stdoutParser` id and the
  `permissionStyle` id, referenced as two INDEPENDENT axes (no bundled `family` id). Changing or removing one is a
  breaking change to the system-entity contract (see Compatibility).
- **Pure data** — strings/objects the engine substitutes or compares without dispatching to code: `binary`,
  `argTemplate`, `schemaDelivery`, `promptDelivery`, `kind`, `constraints`, `capabilities`, `timeouts`,
  `versionProbe`.

### Manifest field schema

One manifest binds a concrete runner id to a `stdoutParser` id and a `permissionStyle` id (two independent code
axes — no bundled `family` id) and fills declarable fields.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | string | yes | The runner id used by `role.runner` today (`src/control-plane/definitions.ts:9,112`). Code-referenced key into the registry. |
| `stdoutParser` | string | yes | Code-referenced id of the StdoutParser strategy (below). Independent of `permissionStyle`. |
| `permissionStyle` | string | yes | Code-referenced id of the PermissionStyle strategy (below). Independent of `stdoutParser`. |
| `kind` | enum `cli`\|`api`\|`gateway`\|`deterministic-script` | yes | The transport CLASS (a manifest field, NOT a capability): `cli` spawns a binary, `api` calls a hosted endpoint, `gateway` routes `provider/model` through a provider gateway, `deterministic-script` is the in-process script runner. Data, not a code-dispatch key. |
| `binary` | string | when `kind=cli` | Executable name or absolute path; feeds `ExecRequest.command` (`src/worker/process-executor.ts:13`). Replaces the literal default `'claude'` in code. |
| `versionProbe` | object `{ args: string[], parse?: stdoutParserId }` | no | Argv to print a version (e.g. `['--version']`) for `needsLivePreflight`/doctor. **Absent → the version check is SKIPPED (not a failure)**; when `needsLivePreflight: true`, the clean/base preflight (auth + worktree state) still runs — only the binary-version probe is omitted. |
| `argTemplate` | string[] | when `kind=cli` | Ordered argv with placeholders, substituted before spawn (see Placeholders). |
| `schemaDelivery` | enum `inline-flag`\|`file-flag`\|`none` | yes | How the result schema reaches the runner. Claude=`inline-flag` (`src/worker/claude-code-runner.ts:159`), Codex=`file-flag` (`src/worker/codex-runner.ts:160-161`, file written at `:97-102`), OpenCode=`none`. |
| `promptDelivery` | enum `stdin`\|`stdin-dash`\|`arg` | yes | How the prompt reaches the runner. Claude pipes on stdin (`ExecRequest.input`, `src/worker/claude-code-runner.ts:254`); Codex uses stdin with a trailing `-` argv terminator (`src/worker/codex-runner.ts:175`, `:541`) → `stdin-dash`. |
| `constraints` | object (see below) | no | Declarative provider/auth requirements. Replaces `requireCompatibleProfile` (`src/worker/codex-runner.ts:179-186`). |
| `capabilities` | object (see [runner-capabilities-v1.spec.md](./runner-capabilities-v1.spec.md)) | yes | The fields that replace the four hardcoded branch functions plus the structured-output tier. `kind` is NOT under `capabilities`. |
| `timeouts` | object `{ idleTimeoutMs?: number, wallClockLimitMs?: number }` | no | Runner-level defaults; role `timeoutMs` still overrides per role (`src/control-plane/definitions.ts:18-19`, `src/worker/claude-code-runner.ts:200-204`). Engine defaults remain `DEFAULT_RUNNER_IDLE_TIMEOUT_MS`/`DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS` (`src/worker/process-executor.ts:32-33`). Timeout policy itself is owned by the [runner contract](../runner-contract.md). |

#### `constraints`

| Field | Type | Meaning |
|---|---|---|
| `allowedProviders` | string[] | If present, the resolved `ModelProfile.provider` (`src/control-plane/definitions.ts:46`) must match one entry (case-insensitive substring, matching today's `isOpenAiCompatibleProvider` at `src/worker/codex-runner.ts:109-112`). Empty/absent → any provider. A mismatch is a typed precondition failure routed to a lesson, replacing the throw at `src/worker/codex-runner.ts:183-185`. |
| `requiresNonEmptyModelId` | boolean | Mirror of the model-id guard at `src/worker/codex-runner.ts:180-182`. Default `true`. |

#### `RouteRoleBinding` gains snapshot fields (named schema change)

`RouteRoleBinding` today is `{roleId, rowId, modelLevel, runnerId, resolvedRunnerId, runnerSource}`
(`src/pipeline/route-contract.ts:9-16`). Under this spec it GAINS snapshot fields:

```ts
type RouteRoleBinding = {
  roleId: string;
  rowId: string;
  modelLevel: string;
  runnerId: string;
  resolvedRunnerId: string;
  runnerSource: 'playbook' | 'execution-profile';
  // added by ADR-0004 (the determinism fix, a named schema change — not silently deferred):
  stdoutParserId: string;
  permissionStyleId: string;
  capabilities: RunnerCapabilities;   // the resolved capabilities block
  manifestDigest: string;             // audit / mismatch-detection only (see Replay model)
  manifestVersion: string;
};
```

### Placeholders

`argTemplate` and `versionProbe.args` use these substitutions, resolved by the engine just before building the
`ExecRequest`. **Schema placeholders are unified by `schemaDelivery`**: `inline-flag` → only `{schemaInline}` is
defined; `file-flag` → only `{schemaPath}` is defined; `none` → neither.

| Placeholder | Source | Provenance / omit-if-empty |
|---|---|---|
| `{model}` | `ModelProfile.modelId` (`src/control-plane/definitions.ts:47`) | always defined |
| `{cwd}` | resolved worktree dir (`src/worker/claude-code-runner.ts:209`, `src/worker/codex-runner.ts:515`) | always defined |
| `{schemaInline}` | the inline JSON-schema STRING (`AGENT_RESULT_SCHEMA` serialized, `src/worker/result-envelope.ts:7-27`), substituted as a flag value (`src/worker/claude-code-runner.ts:159`) | defined only when `schemaDelivery=inline-flag`; otherwise the pair is dropped |
| `{schemaPath}` | path written when `schemaDelivery=file-flag` (`src/worker/codex-runner.ts:97-102`, used at `:160-161`) | defined only when `schemaDelivery=file-flag`; otherwise the pair is dropped |
| `{allowedTools}` | `role.allowedTools` joined per `permissionStyle` (`src/worker/claude-code-runner.ts:161-163`) | rendered by the PermissionStyle; empty → pair dropped |
| `{sandbox}` | the `sandbox-enum` level chosen by the PermissionStyle (`src/worker/codex-runner.ts:144-155`) | meaningful only for `sandbox-enum` style; **absent from `argTemplate` when `permissionStyle ≠ sandbox-enum`** (symmetry with the schema-placeholder unification) |
| `{permissionMode}` | `role.permissionMode ?? 'default'` (`src/worker/claude-code-runner.ts:205`) | supplied by the `tool-allowlist` style; omit the pair if the runner has no permission-mode flag |

**Placeholder drop rule.** When a placeholder resolves to empty/undefined, the engine drops the PAIR — the
immediately preceding flag token AND the placeholder arg — not just the placeholder, so no dangling flag is
emitted. This generalizes today's behavior where `--allowedTools <value>` is pushed only when the list is non-empty
(`src/worker/claude-code-runner.ts:161-163`); the same applies to `--json-schema {schemaInline}`,
`--output-schema {schemaPath}`, and the `--sandbox {sandbox}` pair when `{sandbox}` is undefined.

### StdoutParser contract (CODE system entity)

A `StdoutParser` is a pure function the engine selects by the manifest's `stdoutParser` id. It is irreducibly code:
it walks a vendor-specific event tree. It MUST NOT spawn processes, read files, or call DBOS — that is the runner
adapter's job; the parser only transforms an already-captured stream.

Input:

```ts
type StdoutParserInput = {
  stdout: string;          // full captured stdout (or streamed line-by-line; see note)
  stderr: string;          // full captured stderr
  exitCode: number | null; // see exit-code states below
};
```

**`exitCode` states** (the `ExecResult.code: number | null` field is typed at `src/worker/process-executor.ts:53`
and populated from the process `close` event at `:281`, where Node delivers `null` on signal kill):

- `0` — normal exit. The parser proceeds to terminal reduction; `status.kind` depends on harvested content (`'ok'`
  on a clean envelope, `'needsHuman'` on a parser-detectable block, `'failed'` if the stream reports a turn failure
  even at exit 0).
- non-zero — error exit. `status.kind: 'failed'` unless the stream/stderr matches a `needsHuman` predicate (e.g.
  Codex permission-blocked), in which case `'needsHuman'`.
- `null` — killed by signal (no clean exit code). Treated as `status.kind: 'failed'` with a signal/abort reason.

Live parsers may also consume the line stream incrementally for observability (Claude buffers JSONL lines at
`src/worker/claude-code-runner.ts:232-273`; Codex uses a streaming collector at `src/worker/codex-runner.ts:378-417`).
The contract here is the terminal reduction; incremental observability is an additive callback, not part of the
result contract.

Output:

```ts
type StdoutParserResult = {
  structured: unknown;     // the harvested result object (the result envelope, pre-validation)
  verdict?: string;        // convenience copy of structured.verdict, if cheap to read
  usage: { costUsd?: number; inputTokens?: number; outputTokens?: number };
  liveEvents?: unknown[];  // optional normalized per-turn events for the observability feed
  status:
    | { kind: 'ok' }
    | { kind: 'failed'; reason: string }
    | { kind: 'needsHuman'; lesson?: string };
};
```

Mapping to today's code:

- `structured` ← Claude `transport.structuredOutput` (`src/worker/result-envelope.ts:134`, consumed at
  `src/worker/claude-code-runner.ts:308`); Codex `summary.finalStructured` from the terminal-event walk
  (`src/worker/codex-runner.ts:347-350`, `:261-269`).
- `usage` ← Claude `parseTransportEnvelope` cost/token fields (`src/worker/result-envelope.ts:121-134`); Codex
  `usageFromEvent` (`src/worker/codex-runner.ts:287-306`).
- `status.failed` ← Claude `is_error` / non-zero exit (`src/worker/claude-code-runner.ts:292-306`); Codex
  `turn.failed` (`src/worker/codex-runner.ts:271-279`, `:581-589`).
- `status.needsHuman` is the parser-detectable block. For Codex: the `permissionBlockedText` predicate over an event
  (`src/worker/codex-runner.ts:281`) sets `summary.permissionBlocked` during the walk (`:344`), and the block is
  raised at the runner's exit/turn-failure handling (`:572-585`). A deliberate agent `needsHuman` in the result
  body is carried by `structured`, not this status — the engine already distinguishes a transient runner failure
  from a deliberate block (`src/pipeline/data-driven-task.workflow.ts:369-409`).

Live parser ids: `stream-json` (Claude), `jsonl-exec` (Codex). Anticipated: `parts-stream` (OpenCode), `openai-api`,
`acp` — `(unverified)` against orchestrator source today (no `opencode`/`acp` references exist).

### PermissionStyle contract (CODE system entity, DATA-driven)

A `PermissionStyle` maps portable `role.rights` + `role.allowedTools` (`src/control-plane/definitions.ts:10,17`) to
a runner's native permission expression. The code is a tiny per-style interpreter; the mapping table is data the
style consumes.

Input:

```ts
type PermissionStyleInput = {
  rights?: string;        // role.rights (src/control-plane/definitions.ts:17)
  allowedTools: string[]; // role.allowedTools (src/control-plane/definitions.ts:10)
};
```

Output:

```ts
type PermissionStyleOutput = {
  // Named argv fragments the engine substitutes into argTemplate placeholders.
  fragments: Record<string, string | string[]>;
  // e.g. { allowedTools: ["edit","write"] }  or  { sandbox: "workspace-write" }
};
```

A fragment value is a **`string`** for a single scalar token (`sandbox: "workspace-write"`,
`permissionMode: "acceptEdits"`) or a **`string[]`** for a multi-valued list (`allowedTools: ["edit","write"]`).
When a fragment is an array, the engine joins it into the single placeholder arg using the **separator the
manifest/style declares for that fragment** — for `--allowedTools` today the separator is a comma
(`role.allowedTools.join(',')`, `src/worker/codex-runner.ts:161-163`; Claude joins identically at
`src/worker/claude-code-runner.ts:161-163`). An empty `string[]` triggers the placeholder drop rule.

- **`tool-allowlist` (Claude).** Renders `{allowedTools}` as a `string[]` joined with `,`
  (`src/worker/claude-code-runner.ts:161-163`); empty list → omit the flag pair (most restrictive). Supplies
  `{permissionMode}` as a scalar from `role.permissionMode ?? 'default'` (`src/worker/claude-code-runner.ts:205`).
  No rights→level collapse: the allowlist *is* the expression.
- **`sandbox-enum` (Codex).** Collapses to `read-only` | `workspace-write` via this DATA table (verbatim from
  `src/worker/codex-runner.ts:114-133`, expressed declaratively):

  ```jsonc
  {
    "writeToolNames": ["edit", "multiedit", "notebookedit", "write"],   // any forces workspace-write (codex-runner.ts:114, 144-145)
    "rightsToLevel": {
      "workspace-write": [
        "git and github writes", "git-gh", "write", "write working tree",
        "write-working-tree", "working tree write", "working-tree-write"
      ],
      "read-only": [
        "", "deploy-read", "qa-live", "read only", "read-only",
        "read-only pr inspection", "readonly", "state and routing only"
      ]
    },
    "unknownRightsBehavior": "fail"   // throw/lesson on an unmapped non-empty label (codex-runner.ts:151-153)
  }
  ```

  Resolution order (`sandboxForRole`, `src/worker/codex-runner.ts:144-155`): a write tool in `allowedTools` →
  `workspace-write`; else a label in the `workspace-write` set → `workspace-write`; else a label in the `read-only`
  set → `read-only`; else a non-empty unmapped label → fail; else (empty) → `read-only`. Label normalization
  (`normalizedPolicyLabel`, `src/worker/codex-runner.ts:135-137`): trim, lowercase, `_`→`-`, collapse whitespace.
- **`none` (stub).** Supplies no fragments. Used by the `script`/`stub-agent` dispatch
  (`src/worker/runner-dispatch.ts:14-17`).

### Where the manifest plugs in

- **Build-request:** the engine substitutes `argTemplate` placeholders, invokes the `PermissionStyle` for
  `{allowedTools}`/`{sandbox}`, delivers the schema per `schemaDelivery` and the prompt per `promptDelivery`, then
  builds an `ExecRequest` (`src/worker/process-executor.ts:12-24`) — unchanged.
- **Parse-response:** the engine selects the manifest's `stdoutParser` and maps its output to `AttemptResult`
  (`src/worker/runner.ts:8-18`), lifting + lowercasing the envelope `verdict` per the result-envelope spec.
- The `switch (role.runner)` factory (`src/worker/runner-dispatch.ts:6-22`) becomes a registry lookup keyed by
  `runner.id` → manifest → `(stdoutParser, permissionStyle)` pair.

### Replay model (which fields are pinned, and why)

The resolved capability set is **snapshotted into `RouteRoleBinding` (inside `RouteDecision`) at route time, pinned
into the DBOS workflow args, and read FROM THAT PIN on replay**. The route already rides this durability seam:
`DataDrivenTaskOpts.route: RouteDecision` is a DBOS workflow argument (`src/pipeline/data-driven-task.workflow.ts:94`),
and the sibling pinned fields are documented as "a DBOS workflow arg ⇒ durable on recovery" / "pinned before DBOS
workflow enqueue so recovery cannot branch on changed process env" (`:92-98`). The manifest registry is **NEVER
consulted during workflow execution or DBOS recovery**.

Be exact about what is pinned and why:

- **Capability fields consumed in the DETERMINISTIC workflow body** — `needsLivePreflight`, `performsMerge`,
  `producesWorktreeChanges` — MUST be pinned. The workflow body re-runs on replay and would otherwise recompute
  them from a mutable registry, branching differently than the original run.
- **`stdoutParser` / `permissionStyle` ids** are consumed inside the `runStep` effect (a memoized DBOS step). On a
  normal replay the recorded step result is replayed and the parser does NOT re-run; but on **crash-recovery
  RE-EXECUTION** of an incomplete step the same ids must be used, so they are pinned too.
- **`manifestDigest`** is AUDIT / mismatch-detection ONLY: a stable hash over the canonicalized manifest. The
  snapshot is self-contained (it already carries the full ids + `capabilities` block), so replay/recovery reads
  everything from the snapshot and MUST NOT do a content-address lookup-by-digest — that would reopen the
  determinism blocker. A later digest mismatch is an operator/audit signal, not a replay input.

Invariant: a manifest-registry change MID-RUN must not alter `producesWorktreeChanges` / `performsMerge` /
`needsLivePreflight` / the `stdoutParser` id / the `permissionStyle` id / the structured-output tier for an
in-flight run. A run started against digest `D` continues, replays, and recovers against `D` — even after the
operator edits or replaces the manifest. (Whether a NEW run picks up the edited manifest is a selection concern,
out of scope — #186.)

The snapshot makes the routing DECISION deterministic; it does NOT make the external CLI's behavior deterministic.
CLI version, locale, and process env are not pinned, so the standard DBOS external-effect caveat applies — a step
re-executed after the external world changed can diverge — and is explicitly out of this ADR's scope.

## Validation

- **Manifest schema validation at load time.** A manifest with an unknown `stdoutParser`/`permissionStyle` id, a
  missing required field, or an undeclared `kind` is a startup/validation error, not a silent fallback (mirrors
  today's `RUNNER_NOT_IMPLEMENTED` throw at `src/worker/runner-dispatch.ts:12,16,19`, surfaced at manifest-load
  time).
- **Acceptance: manifest-only runner addition (zero code).** A same-`(parser, style)`-pair runner is added by a
  manifest-only change with ZERO code edits, proven by a test: a new manifest reusing an existing pair routes,
  builds args, and parses output through the engine with no source diff.
- **Golden-output immutability test per code-strategy id.** Each `stdoutParser` and each `permissionStyle` id has a
  golden-output test pinning its observable behavior (a fixed input stream / rights set → a fixed normalized
  result / fragment set). This ENFORCES the versioning rule (a behavior change → a NEW id) as a test, not just a
  documented policy: any behavior change to an existing id breaks its golden test, forcing the author to mint a new
  id instead of an in-place swap.
- **Placeholder drop coverage.** A test asserts that an empty `{allowedTools}`, an undefined `{sandbox}` (style ≠
  `sandbox-enum`), and a dropped schema pair each remove the whole flag pair, leaving no dangling flag.
- **Provider-constraint failure is typed, not a throw.** A provider outside `constraints.allowedProviders` produces
  a typed precondition failure routed to a lesson (not an adapter throw), covered by a test.
- **Replay/recovery uses the pin.** A test mutates the registry mid-run and asserts the in-flight run continues
  against its snapshot digest `D` for `producesWorktreeChanges` / `performsMerge` / `needsLivePreflight` / the
  parser/style ids / the tier.

## Compatibility

The system-entity ids (`stdoutParser`, `permissionStyle`) are a PUBLIC, versioned contract once manifests reference
them. Versioning policy:

- **Ids are immutable public contracts.** An id names a fixed behavior; manifests in the wild depend on it.
- **A behavior-CHANGING parser/style ships as a NEW id**, never an in-place behavior swap — e.g. a stream-format
  change is `stream-json` → `stream-json-v2`, and manifests migrate deliberately. This keeps an in-flight run's
  pinned id meaningful (see Replay model). Enforced by the golden-output test above.
- **Additive, backward-compatible data-table changes do NOT need a new id** — e.g. adding a `rights → level` row to
  the `sandbox-enum` table, or a new recognized read-only label, stays on the same id.
- **Adding a brand-new id is backward-compatible.**
- **Renaming or removing an id is breaking**: every manifest referencing it must be migrated in the same change.
  Treat like a plugin API.
- A manifest referencing an unknown id is a startup/validation error, not a silent fallback.

Manifest storage/loading is deferred to the registry decision (#186); this spec defines field shape, not
persistence. This spec refines the [runner contract](../runner-contract.md) (which still owns the runner boundary,
timeout policy, and transient-retry policy) without contradicting it.

## Examples

### Filled manifest — claude-code

```json
{
  "id": "claude-code",
  "stdoutParser": "stream-json",
  "permissionStyle": "tool-allowlist",
  "kind": "cli",
  "binary": "claude",
  "versionProbe": { "args": ["--version"] },
  "argTemplate": [
    "-p", "--model", "{model}",
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "{permissionMode}",
    "--json-schema", "{schemaInline}",
    "--allowedTools", "{allowedTools}"
  ],
  "schemaDelivery": "inline-flag",
  "promptDelivery": "stdin",
  "constraints": {},
  "capabilities": {
    "needsLivePreflight": true,
    "performsMerge": false,
    "producesWorktreeChanges": true,
    "supportsStructuredOutput": "native-schema",
    "provider": "anthropic",
    "authMode": "cli-session",
    "privacyClass": "external",
    "supportsWorkspaceWrite": true
  }
}
```

Grounding: argv at `src/worker/claude-code-runner.ts:151-169`; `--allowedTools` omitted when `role.allowedTools` is
empty (`:161-163`). `--max-turns` from `ModelProfile.params` (`:164-167`) is a params-driven optional addition, not
a manifest field.

### Filled manifest — codex

```json
{
  "id": "codex",
  "stdoutParser": "jsonl-exec",
  "permissionStyle": "sandbox-enum",
  "kind": "cli",
  "binary": "codex",
  "versionProbe": { "args": ["--version"] },
  "argTemplate": [
    "exec", "--json",
    "--output-schema", "{schemaPath}",
    "-c", "approval_policy=\"never\"",
    "--model", "{model}",
    "--sandbox", "{sandbox}",
    "--cd", "{cwd}",
    "--ephemeral", "--ignore-user-config", "--color", "never",
    "-"
  ],
  "schemaDelivery": "file-flag",
  "promptDelivery": "stdin-dash",
  "constraints": {
    "allowedProviders": ["openai", "codex"],
    "requiresNonEmptyModelId": true
  },
  "capabilities": {
    "needsLivePreflight": true,
    "performsMerge": false,
    "producesWorktreeChanges": true,
    "supportsStructuredOutput": "native-schema",
    "provider": "openai-compatible",
    "authMode": "cli-session",
    "privacyClass": "external",
    "supportsWorkspaceWrite": true
  }
}
```

Grounding: argv at `src/worker/codex-runner.ts:157-177`; schema file written at `:97-102`; the `-` argv terminator
and stdin prompt at `:175` + `:541`; `constraints.allowedProviders` reproduces `isOpenAiCompatibleProvider`
(`:109-112`).

## Changelog

- 2026-06-29: Initial version.
