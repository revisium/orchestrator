# Script runtime v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo runtime, script registry, built-in integrations
- **Source files:** `src/system-scripts/**`, `src/pipeline/data-driven-task.workflow.ts`,
  `src/pipeline/pipeline.service.ts`, `src/runners/integrator.ts`
- **Related ADRs:** [ADR-0011](../adr/0011-system-script-runtime-and-trusted-extensions.md),
  [ADR-0010](../adr/0010-run-resources-and-workspace-planning.md)
- **Related specs:** [execution plan v1](./execution-plan-v1.spec.md),
  [pipeline state machine v1](./pipeline-state-machine-v1.spec.md),
  [resources, workspaces, and effects v1](./resources-workspaces-effects-v1.spec.md),
  [run dataflow v1](./run-dataflow-v1.spec.md),
  [human gates v1](./human-gates-v1.spec.md)

## Scope

This spec defines the trusted script runtime and its built-in system-script contract: serializable manifests, runtime definitions,
`defineScript`, explicit registration, execution context/result, plan pins, folder layout, startup loading, centralized
effect policy, test kit, and the V1 approval/Git/GitHub operation inventory.

It does not define run-output artifact schemas, gate transitions, worktree lifecycle, arbitrary user code, runtime
plugin installation, a public SDK, or a provider-neutral delivery facade. Those boundaries belong to the linked owner
contracts.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are interpreted as in RFC 2119 / BCP 14.

## Current Contract

The shipped workflow builds a broad system-script registry inside `data-driven-task.workflow.ts`, while
`PipelineService` registers DBOS steps separately. `IntegratorService` multiplexes Git and GitHub behavior.
`pollPr` contains waiting/readiness behavior and a mark-ready mutation. Worktree cleanup is exposed as an ordinary
script node. Generic workflow code also recognizes concrete script and node ids.

The target below is not shipped. The migration is an atomic replacement: old script refs, multiplexer modes,
workflow-local registry construction, worktree cleanup script, and id-specific executor branches are deleted with the
bundled pipeline cutover. No aliases or fallback dispatch path remain.

## Target Contract

### Serializable manifest

```ts
type ScriptManifestV1 = {
  schemaVersion: 'system-script-manifest/v1';
  id: `script:${string}`;
  version: string;
  summary: string;
  inputSchemaRef: string;
  resultSchemaRef: string;
  verdict?: { jsonPointer: string };
  resources: Array<{
    kind: 'repository';
    access: 'read' | 'write' | 'publish' | 'admin';
  }>;
  credentials: Array<'git' | 'github'>;
  effects: ScriptEffect[];
  timeout: { wallClockMs: number };
  retry: {
    mode: 'never' | 'transient';
    maxAttempts: number;
    backoffMs: number[];
  };
  idempotency: 'read-only' | 'required' | 'not-retryable';
  redaction: {
    inputPaths: string[];
    resultPaths: string[];
  };
  progress: {
    allowedDetailPaths: string[];
    redactedPaths: string[];
  };
};

type ScriptEffect =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'git.read'
  | 'git.write'
  | 'git.remote-write'
  | 'github.read'
  | 'github.write';
```

Rules:

- manifests MUST be JSON-serializable and pass a closed JSON Schema with `additionalProperties: false`;
- `id` MUST match `^script:[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)+$`;
- `version` is immutable semantic identity for one observable handler contract;
- schema refs are stable ids, not filesystem paths;
- `verdict.jsonPointer`, when present, follows RFC 6901 and MUST resolve in the closed result schema to a required
  string enum whose values are declared as pipeline domain verdicts;
- resource declarations state the maximum access the operation can use; a node may grant the same or lower access;
- retry is bounded; `maxAttempts` includes the first attempt and MUST equal `backoffMs.length + 1` when transient;
- `read-only` operations may be retried with no idempotency key;
- write effects use `required` with a deterministic idempotency key, or `not-retryable` with one attempt;
- secret-bearing input, result, progress, and error evidence is centrally redacted; progress details are rejected
  unless their paths are in `progress.allowedDetailPaths`, then `progress.redactedPaths` is applied before emission;
- manifests contain no function, token, environment value, absolute workspace path, or handler source.

### ScriptDefinition and defineScript

```ts
type RuntimeSchema<T> = {
  parse(value: unknown): T;
  toJsonSchema(): object;
};

type ScriptDefinition<I, O> = {
  manifest: ScriptManifestV1;
  inputSchema: RuntimeSchema<I>;
  resultSchema: RuntimeSchema<O>;
  handler: ScriptHandler<I, O>;
  implementation: {
    handlerId: string;
    buildDigest: string;
  };
  definitionDigest: string;
};

type ScriptHandler<I, O> = (
  input: Readonly<I>,
  context: Readonly<ScriptContext>,
) => Promise<ScriptHandlerResult<O>>;

declare function defineScript<I, O>(definition: {
  manifest: ScriptManifestV1;
  inputSchema: RuntimeSchema<I>;
  resultSchema: RuntimeSchema<O>;
  handler: ScriptHandler<I, O>;
  implementation: {
    handlerId: string;
    buildDigest: `sha256:${string}`;
  };
}): ScriptDefinition<I, O>;
```

`defineScript` MUST:

1. validate the manifest;
2. require the runtime schemas to export JSON Schemas whose canonical ids match the manifest refs;
3. validate any verdict pointer against a required string-enum field in the result JSON Schema;
4. validate retry/effect/idempotency coherence;
5. require build-generated handler identity and a SHA-256 digest of the packaged handler module/artifact;
6. canonicalize the manifest, input/result JSON Schemas, handler id, and build digest through the
   `src/run-resources/canonical-json.ts` wrapper fixed by execution-plan-v1;
7. compute `definitionDigest = sha256:<lowercase-hex>` over that canonical document;
8. deep-freeze the returned definition in development/test builds.

The build digest is generated by the trusted build, not hand-authored in playbook data and not recomputed from source at
runtime. The fixed V1 generator, artifact, byte framing, and freshness command are defined under "Fixed V1 delivery
mechanisms" below. `version` is the author-declared contract identity; a behavior-changing handler requires a new
version even though the package build digest also detects any packaged-code change. Package build/release provenance is
recorded separately at registry startup. CI verifies generated build-digest freshness.

Handler code and executable runtime-schema objects are trusted host code. They MUST NOT be serialized into playbooks,
profiles, run outputs, or execution plans.

### Context and result

```ts
type ScriptContext = {
  runId: string;
  taskId: string;
  nodeId: string;
  stepKey: string;
  attempt: number;
  executionPlanHash: string;
  definition: { id: string; version: string; digest: string };
  idempotencyKey?: string;
  workspace: {
    workspaceId: string;
    provider: 'scratch' | 'git-worktree';
  };
  resources: Record<string, ScriptResourceHandle>;
  signal: AbortSignal;
  emitProgress: (event: ScriptProgressEvent) => Promise<void>;
};

type ScriptResourceHandle = {
  name: string;
  kind: 'repository';
  access: 'read' | 'write' | 'publish' | 'admin';
  repositoryId: string;
  clients: {
    filesystem?: BoundedFilesystemClient;
    git?: BoundedGitClient;
    github?: BoundedGitHubClient;
  };
};

type ScriptHandlerResult<O> = {
  value: O;
  evidence?: Array<{
    kind: 'artifact' | 'log' | 'external';
    ref: string;
    summary?: string;
  }>;
};

type ScriptProgressEvent = {
  phase: string;
  message: string;
  details?: Record<string, unknown>;
};
```

The host constructs context; pipeline/playbook data cannot provide it. `BoundedFilesystemClient`, `BoundedGitClient`,
and `BoundedGitHubClient` are closed host APIs, not generic shell, filesystem-root, HTTP, or GraphQL clients. The host
provides a client only when the manifest effect, node grant, resource plan, and pinned credential alias all permit it.
Clients resolve host-local credentials internally and never expose token strings or environment maps to handlers.

System-script handlers receive no absolute workspace path, process environment, generic network client, Prisma, DBOS,
credential resolver, or control-plane service. Trusted built-in/plugin packages enforce that boundary through package
imports/lint policy plus integration tests. Runner processes are a separate contract: workspace lifecycle supplies their
resolved cwd under runner sandbox/permission policy. Handlers MUST NOT return secrets.

A handler returns domain data only. It does not return routing destinations, mutate counters, resolve gates, start
other nodes, edit the execution plan, or enqueue workflows. Domain verdict extraction remains the adapter/dataflow
contract.

### Registry and startup

```ts
type SystemScriptRegistry = {
  register(definition: ScriptDefinition<unknown, unknown>, provenance: DefinitionProvenance): void;
  seal(): void;
  resolve(id: string, version: string): ScriptDefinition<unknown, unknown>;
  getExact(id: string, version: string, digest: string): ScriptDefinition<unknown, unknown>;
  listManifests(): ScriptManifestV1[];
};

type DefinitionProvenance = {
  packageName: string;
  packageVersion: string;
  buildId: string;
  source: 'builtin' | 'trusted-plugin';
};
```

Built-ins MUST be imported and registered explicitly in one host composition root. Directory scanning and implicit
side-effect registration are forbidden. Registration fails startup on duplicate `(id, version)`, duplicate digest with
different canonical content, invalid definition, or unapproved provenance. The registry is sealed before the host
accepts run creation.

After database access is available and before run creation or DBOS recovery starts, startup MUST compare every
resume/recovery-eligible execution plan's script pins with the sealed registry. A missing exact definition fails startup
with `REVO_SCRIPT_BUILD_PIN_UNAVAILABLE`; startup MUST NOT silently leave recovery to a later substitute.

A future trusted plugin package may export a registration function using `defineScript` and may be loaded from static
host configuration only during startup. It receives no bypass around validation or manifest rules. Runtime package
download, hot reload, playbook-provided module paths, and untrusted code are forbidden in V1.

Target script nodes use an explicit versioned reference:

```ts
type ScriptRefV1 = {
  id: `script:${string}`;
  version: string;
};
```

The compiler calls `resolve(id, version)` and snapshots the one installed definition. A string-only script ref, implicit
latest version, version range, digest in playbook data, or fallback selection is invalid. Recovery uses `getExact` with
the plan's definition digest.

### Execution-plan pin

ADR-0010 stores one pin per operation used by the materialized graph:

```ts
type ScriptDefinitionPin = {
  id: string;
  version: string;
  definitionDigest: string;
  manifest: ScriptManifestV1;
  inputJsonSchema: object;
  resultJsonSchema: object;
  implementation: { handlerId: string; buildDigest: string };
  provenance: DefinitionProvenance;
};
```

The compiler resolves definitions from the sealed startup registry, validates node requirements against manifest
maximums, and snapshots the serializable pin. Execution and recovery use the pinned manifest/schemas for validation
and audit, then call `getExact`. A missing or mismatched trusted definition produces
`revo.ExecutionDependencyUnavailable` before any new effect. The host MUST NOT substitute another version or digest.

This lookup does not reopen mutable policy: startup code is an executable dependency, analogous to a pinned runner
parser strategy. All mutable selection data is already in the plan.

### Generic execution algorithm

For every script node, the adapter performs the same steps:

1. read the node and definition pin from the persisted execution plan;
2. resolve the exact installed definition;
3. resolve the node's pinned `inputBindings` over hydrated output aliases, the persisted redacted plan, and JSON
   literals using pipeline-state-machine-v1's generic algorithm;
4. validate the resulting input with the pinned input JSON Schema and runtime schema;
5. validate declared node access against the manifest and construct only the bounded clients allowed by the node,
   resource plan, manifest effects, and pinned credential aliases;
6. derive the idempotency key from `(runId, nodeId, ordinal, definitionDigest)` when required;
7. emit `script.started` with redacted metadata;
8. execute under the manifest wall-clock timeout and abort signal;
9. retry only typed transient failures allowed by the pinned retry policy;
10. validate the result with runtime and pinned result schemas;
11. when `manifest.verdict` exists, extract the required string enum through run-dataflow-v1's generic rule and set the
    domain verdict without comparing concrete ids;
12. apply central redaction, the closed progress allowlist, and payload limits;
13. persist outputs through run-dataflow-v1 and emit `script.succeeded` or a typed failure event.

Generic code MUST NOT compare the concrete definition id or node id. It may compare manifest enum values and declared
effects. Unknown definitions, undeclared resource use, invalid input/result, timeout, credential resolution failure,
and idempotency conflicts are typed `revo.*` failures.

### Error contract

Minimum error codes:

| Code | Meaning | Retry eligibility |
| --- | --- | --- |
| `revo.ScriptInputInvalid` | Input failed pinned/runtime schema validation. | never |
| `revo.ScriptResultInvalid` | Handler result failed validation. | never |
| `revo.ScriptAccessDenied` | Requested resource/effect exceeds declarations. | never |
| `revo.ScriptCredentialUnavailable` | Required alias cannot resolve in host state. | only if manifest permits and error is typed transient |
| `revo.ScriptTimedOut` | Wall-clock bound expired. | only if manifest permits |
| `revo.ScriptTransient` | Handler/client reported a retry-safe transient failure. | per manifest |
| `revo.ScriptBlocked` | Safe continuation needs operator action. | never automatically |
| `revo.ScriptFailed` | Non-transient operation failure. | never |
| `revo.ExecutionDependencyUnavailable` | Exact installed definition does not match the pin. | never automatically |

Raw provider messages are evidence, not error codes, and MUST be redacted.

### Folder layout

Every public built-in operation has one folder:

```text
src/system-scripts/
  registry.ts
  test-kit.ts
  git/
    commit/
      manifest.json
      input.schema.json
      result.schema.json
      definition.ts
      handler.ts
      handler.test.ts
      contract.test.ts
      CONTRACT.md
  github/
    pull-request/
      readiness/
        manifest.json
        input.schema.json
        result.schema.json
        definition.ts
        handler.ts
        handler.test.ts
        contract.test.ts
        CONTRACT.md
    review-threads/
      respond/
        manifest.json
        input.schema.json
        result.schema.json
        definition.ts
        handler.ts
        handler.test.ts
        contract.test.ts
        CONTRACT.md
```

`manifest.json` and JSON Schema files are canonical serializable artifacts. `definition.ts` loads them, constructs
matching runtime schemas, and calls `defineScript`. `handler.ts` contains only the bounded operation. Tests and
`CONTRACT.md` are required in the same folder. Shared private clients live outside operation folders and are not
registered operations.

`CONTRACT.md` MUST document purpose, non-goals, input/result examples, resource/effect/credential requirements,
idempotency, retryable failures, redaction, and provider assumptions. It is explanatory; machine-readable files remain
authoritative.

### V1 operation inventory

The initial public registry uses explicit operations. Exact payload schemas live in each operation folder; artifact
schemas they produce remain canonical in run-dataflow-v1.

| Operation id | Purpose | Effects | Access | Idempotency / stale fence | Crash-window reconciliation |
| --- | --- | --- | --- | --- | --- |
| `script:approval/subject` | Produce `schema:approvalSubject/v1`. | none | none | read-only/pure | Recompute and validate the same value. |
| `script:git/status` | Snapshot workspace state. | filesystem.read, git.read | read | read-only | Re-read. |
| `script:git/commit` | Commit a pinned workspace change. | filesystem.read, git.write | write | required; exact base/tree and operation key | Return an existing matching commit marker; a conflicting head blocks. |
| `script:git/push` | Push the pinned branch/head. | git.read, git.remote-write | publish | required; expected remote and exact head | Remote already at exact head is success; any other head blocks. |
| `script:github/pull-request/upsert` | Create/update the run-owned PR. | github.read, github.write | publish | required; run marker, head/base, expected PR revision | Find the unique marker/head PR before create; ambiguity blocks. |
| `script:github/pull-request/mark-ready` | Mark the exact draft PR ready. | github.read, github.write | publish | required; PR identity and head | Already non-draft at the same head is success; changed head blocks. |
| `script:github/pull-request/readiness` | Return one readiness snapshot. | github.read | read | read-only | Re-read one snapshot. |
| `script:github/review-threads/respond` | Reply to selected threads. | github.read, github.write | publish | required; thread ids, head, per-reply marker | Existing matching marked reply is success; ambiguity blocks. |
| `script:github/review-threads/resolve` | Resolve selected replied threads. | github.read, github.write | publish | required; thread ids and matching reply marker | Already resolved after the matching reply is success; otherwise block. |
| `script:github/pull-request/merge` | Merge the approved head. | github.read, github.write | admin | required; PR identity, approved head, fresh readiness | Merged at the exact head is success; any different/unknown state blocks. |

Readiness MUST perform one bounded provider read and return. It MUST NOT sleep, loop, mark ready, resolve threads, or
merge. Pipeline `wait` and `choice` nodes own bounded polling. Mark-ready and merge require independent idempotency keys
and emit separate audit events.

For every `idempotency: required` operation, a deterministic Revo key is necessary but not sufficient. Before retrying
an incomplete DBOS step, the handler MUST observe provider/Git state and either return the already-applied exact effect,
apply it once under the documented precondition, or emit `revo.ScriptBlocked` for explicit reconciliation. Blind write
retry is forbidden. Each operation's folder-local `CONTRACT.md` and contract tests own the exact marker/read-back and
stale-state rules summarized above.

The readiness operation's `CONTRACT.md` owns provider-state classification and MUST satisfy the canonical `clean`
minimum defined once in run-dataflow-v1. Run-dataflow-v1 owns readiness fields/enums and their minimum semantics;
default-playbook-policy owns what each classification does in the graph.

`script:approval/subject` is pure and provider-neutral. It does not discover identity or revision from an external
provider; the pipeline hydrates those values from the exact source outputs. Its validation guarantees gates always
receive the canonical subject schema without teaching gate code about source artifact types.

Git commit/push and pull-request upsert may share private Git/GitHub clients. They remain separate definitions; no
public `mode` parameter selects behavior.

Pull-request upsert owns rendering the issue reference required by the run's `issueAction`. Merge owns verifying that
the exact PR still carries the required closing/reference semantics before merging. `issueAction: none` forbids injected
issue tokens. These operation contracts compose with the canonical issue metadata in run-dataflow-v1.

Worktree preparation/release is absent from this inventory because it is resource lifecycle.

### Fixed V1 delivery mechanisms

These mechanisms are normative. Delivery issues may copy them for executor context but MUST NOT select substitutes.

#### Built-in handler build identity

- `scripts/generate-system-script-build-metadata.mjs` is the sole generator.
- `pnpm run system-scripts:build-metadata:generate` creates a fresh OS temporary directory, performs
  `tsc -p tsconfig.build.json --outDir <temp>/dist --sourceMap false`, hashes every emitted `<temp>/dist/**/*.js`
  runtime file in sorted POSIX-relative-path order, removes the temporary directory, and writes
  `src/system-scripts/generated/builtin-build.ts`. The emitted generated module
  `<temp>/dist/system-scripts/generated/builtin-build.js` is excluded to avoid self-reference.
- Each file contributes `UTF8(relativePath)`, one NUL byte, `UTF8(decimalByteLength)`, one NUL byte, the exact file
  bytes, and one NUL byte to one SHA-256 stream. The result is `sha256:<lowercase-hex>`.
- The generated module exports package name/version from `package.json`, `BUILTIN_PACKAGE_BUILD_ID`, and
  `BUILTIN_PACKAGE_BUILD_DIGEST`; the build id and digest are the same package-runtime hash in V1.
- A built-in definition uses `handlerId = builtin:<script-id>@<version>` and
  `buildDigest = BUILTIN_PACKAGE_BUILD_DIGEST`. Its registry provenance uses package name/version plus
  `buildId = BUILTIN_PACKAGE_BUILD_ID`. Runtime lookup remains the explicit imported definition; no module path or
  dynamic loader is stored in a plan.
- The package build runs metadata generation followed by a clean final TypeScript emission.
  `pnpm run system-scripts:build-metadata:check` repeats the temporary emission and compares the
  expected generated module byte-for-byte without modifying the worktree. `pnpm verify` invokes this check.
- Missing/stale generated metadata fails CI. Duplicate identity, digest/content collision, or provenance mismatch
  fails host startup. Invocation never hashes source or package files.

The package-wide hash intentionally favors safety over digest stability: any emitted runtime-code change gives every
built-in a new build digest. A narrower transitive-module hash is a future optimization, not a delivery-agent choice.

#### Git commit reconciliation

The runtime idempotency key is never written verbatim. The marker fingerprint is
`sha256:<lowercase-hex>` over the UTF-8 idempotency key, and `script:git/commit` appends exactly one Git trailer:

```text
Revo-Operation-Key: sha256:<lowercase-hex>
```

The bounded client normalizes the supplied message to LF, removes any caller-supplied `Revo-Operation-Key` trailer,
and appends the host-owned trailer after one blank line. Before writing, the checked-out branch MUST be the pinned
branch. If `HEAD == expectedParent`, the client verifies the exact approved tree and creates one commit. On replay,
only current `HEAD` may reconcile: it succeeds when there is exactly one marker trailer equal to the fingerprint, one
parent equal to `expectedParent`, and a tree equal to `expectedTree`. The handler does not scan other branches or adopt
another marked commit. Any moved head, duplicate/malformed trailer, marker mismatch, parent mismatch, or tree mismatch
returns `revo.ScriptBlocked` before another commit.

#### GitHub pull-request reconciliation

All marker fingerprints are SHA-256 over UTF-8 values and are not secrets. The run-owned PR key is SHA-256 over the
NUL-delimited tuple `revo-managed-pr/v1`, `runId`, `repositoryId`, and resource name. The terminal managed block in the
PR body is exactly:

```text
<!-- revo-managed-pr:v1 key=sha256:<lowercase-hex> -->
<!-- revo-operation:v1 kind=pull-request-upsert key=sha256:<lowercase-hex> head=<git-commit> content=sha256:<lowercase-hex> -->
```

The operation key fingerprint is SHA-256 over the host idempotency key. `content` is SHA-256 over RFC 8785 canonical
JSON containing the desired title, business body without the managed block, base ref, head ref, and issue action.
There MUST be one managed key line and at most one line for a given operation fingerprint. A malformed, duplicate, or
conflicting block is `revo.ScriptBlocked`.

`GitHubPullRequestV1.providerRevision` is
`github-pr-metadata/v1:sha256:<lowercase-hex>` over RFC 8785 canonical JSON of `{baseRef, headRef, title, body}`, where
`body` excludes the canonical terminal managed block. It intentionally excludes head commit, draft state, comments,
checks, and threads. Head-sensitive effects compare `headCommit` separately; metadata writes compare
`providerRevision`.

Upsert lists candidates for the exact repository/head ref/base ref, reads their bodies, and requires zero or one PR
with the run-owned key. An unmarked candidate at that identity, more than one marked candidate, or a conflicting marker
blocks. Zero candidates permits one draft create. One exact candidate permits read-only success when business metadata
already matches. A metadata update requires the input's prior `providerRevision` to equal the observed revision; absent
or stale revision blocks. After create/update, read-back must match the run key, operation marker, issue semantics,
refs, exact expected head, and newly computed revision. Mark-ready independently requires the consumed
`providerRevision`, exact PR identity, open state, and exact head; already non-draft at those values is success.

#### Review-thread reconciliation

Each reply appends exactly one terminal marker:

```text
<!-- revo-thread-reply:v1 key=sha256:<operation-key> pr=<number> head=<git-commit> thread=sha256:<thread-id> body=sha256:<reply-body> -->
```

The operation fingerprint is SHA-256 over the host idempotency key. Thread and body fingerprints are SHA-256 over the
provider thread id and the LF-normalized reply body without the marker. Before posting, the handler verifies the exact
open PR/head/thread and searches that thread's comments. Exactly one marker authored by the pinned credential actor
with matching PR, head, thread, and body is idempotent success. A duplicate, malformed, foreign-author, or mismatched
marker blocks. The response result records provider reply id plus the exact marker and fingerprint. Resolve consumes
that response result, re-reads the same thread, requires exactly one matching reply before mutation, and treats an
already resolved thread as success only while that reply remains visible.

#### Exact-code recovery and retention

V1 does not download or side-load historical code. A deployment MUST retain the exact previously installed package
binary while any execution plan that pins its built-in build digest remains eligible for resume or recovery. Before
upgrade, the operator completes or explicitly cancels those runs; otherwise the candidate host's startup pin audit
fails with `REVO_SCRIPT_BUILD_PIN_UNAVAILABLE`. The operator must restore the exact package build to resume/cancel the
runs and may then retry the upgrade. There is no override that substitutes code, rewrites pins, or starts recovery with
a missing digest. Terminal, non-resumable runs do not require executable retention.

### Test kit

`src/system-scripts/test-kit.ts` exposes only test mechanics:

```ts
type ScriptContractHarness<I, O> = {
  validateManifest(): void;
  validateExamples(): void;
  invoke(input: I, overrides?: Partial<ScriptContext>): Promise<O>;
  assertNoUndeclaredEffects(): void;
  assertRedacted(value: unknown): void;
  replaySameIdempotencyKey(): Promise<{ first: O; second: O }>;
  crashAfterEffectThenReconcile(): Promise<{ observed: O; duplicateEffects: 0 }>;
};
```

Required per-operation proof:

- manifest and both schemas are valid and closed;
- `CONTRACT.md` examples validate against schemas;
- handler uses no undeclared resource/effect/credential;
- timeouts and typed transient retry stay within manifest bounds;
- write idempotency prevents duplicate external effects;
- crash after an external write but before DBOS result persistence reconciles without a duplicate effect;
- result/error/progress redaction removes fixture secrets;
- definition version/digest fixture changes when observable contract behavior changes;
- generated handler build digest changes when the packaged handler module changes and stale generated metadata fails CI;
- readiness is mutation-free;
- mutation operations reject stale identity/revision preconditions.

Registry tests prove explicit completeness, deterministic order-independent lookup, duplicate failure, sealing, trusted
plugin provenance checks, and exact recovery lookup. A registry meta-test invokes
`crashAfterEffectThenReconcile()` for every definition whose manifest uses `idempotency: required`; adding such an
operation without a reconciliation fixture fails required verification.

## Validation

Plan compilation MUST reject unknown script refs, node access above manifest maximum, missing resource/credential
bindings, effect/idempotency inconsistency, and schema-ref/digest mismatch before enqueue.

Runtime MUST reject any attempt to reach raw workspace paths, credentials, network clients, Prisma, DBOS, or gate
services outside the provided context/clients. Enforcement may combine type boundaries, lint/import rules, client
fakes, and integration tests; tests alone are not permission isolation.

The full-host proof includes:

- `task -> approved plan -> reviewed PR -> merge` using explicit operations;
- a readiness snapshot loop made of script + choice/wait nodes;
- a provider-neutral approval subject at the merge gate;
- recovery after registry/profile/playbook mutation using the same plan pin;
- a repository-free scratch pipeline with no Git/GitHub definitions invoked.

Test ownership follows pipeline-test-coverage-v1: unit/contract tests own manifest, schema, handler, idempotency,
redaction, and provider classification internals; static policy owns operation separation and graph shape; declarative
DSL scenarios own operation calls/no-calls and recovery edges; full integration owns only the representative host
composition proofs.

## Compatibility

This is a direct alpha replacement. Old ids such as `script:integrator`, `script:pollPr`,
`script:confirmMerge`, `script:respondThreads`, and `script:cleanupWorktree` have no aliases. There is no dual registry,
mode dispatcher, legacy result adapter, or in-flight-run migration. Unknown manifest/schema versions and missing exact
definitions fail closed.

Adding a new definition is compatible. Changing manifest, schemas, or observable handler behavior requires a new
definition version/digest. Removing a version is allowed only when no retained execution plan can require it, or when
operators accept that such a run will remain blocked; V1 provides no automatic migration.

The runtime trusts the installed package selected at host startup. It verifies definition and provenance metadata but
does not re-hash source files on every invocation. Reproducible build generation, CI freshness checks, package
attestation, and startup registration are the trust boundary; stale or substituted packaged code that bypasses those
controls is a supply-chain failure, not a runtime replay fallback.

## Open Implementation-shape Questions

These questions do not weaken the fixed manifest/definition/registry boundaries:

- how private Git/GitHub clients are divided internally while keeping every public operation independently bounded;
- how a later multi-resource schema gives manifest resource requirements stable names; V1's unnamed kind/access maximum
  is unambiguous only because one launch may bind at most one repository resource;
- whether a future release format can retain side-by-side trusted build archives without weakening explicit startup
  registration. V1 deliberately uses the startup pin audit and operator-retained package binary instead.

## Examples

Minimal readiness manifest:

```json
{
  "schemaVersion": "system-script-manifest/v1",
  "id": "script:github/pull-request/readiness",
  "version": "1",
  "summary": "Capture one pull-request readiness snapshot without mutation.",
  "inputSchemaRef": "schema:githubPullRequest/v1",
  "resultSchemaRef": "schema:githubReadiness/v1",
  "verdict": { "jsonPointer": "/classification" },
  "resources": [{ "kind": "repository", "access": "read" }],
  "credentials": ["github"],
  "effects": ["github.read"],
  "timeout": { "wallClockMs": 30000 },
  "retry": { "mode": "transient", "maxAttempts": 3, "backoffMs": [250, 1000] },
  "idempotency": "read-only",
  "redaction": { "inputPaths": [], "resultPaths": [] },
  "progress": { "allowedDetailPaths": [], "redactedPaths": [] }
}
```

Explicit registration:

```ts
export function registerBuiltInSystemScripts(registry: SystemScriptRegistry): void {
  registry.register(approvalSubject, builtinProvenance);
  registry.register(gitStatus, builtinProvenance);
  registry.register(gitCommit, builtinProvenance);
  registry.register(gitPush, builtinProvenance);
  registry.register(githubPullRequestUpsert, builtinProvenance);
  registry.register(githubPullRequestMarkReady, builtinProvenance);
  registry.register(githubPullRequestReadiness, builtinProvenance);
  registry.register(githubReviewThreadsRespond, builtinProvenance);
  registry.register(githubReviewThreadsResolve, builtinProvenance);
  registry.register(githubPullRequestMerge, builtinProvenance);
}
```

## Changelog

- 2026-07-12: Fixed build metadata generation, Git/GitHub reconciliation markers, PR metadata revision, review-thread
  proof, exact-code retention, and folder layout as normative V1 delivery mechanisms.
- 2026-07-11: Initial draft.
