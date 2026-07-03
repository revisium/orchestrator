# Run profiles v1 spec

- **Status:** Draft
- **Version:** v1
- **Owners:** Revo runtime, MCP, control plane
- **Source files:** `src/control-plane/topology-profiles.ts`, `src/pipeline-core/materialize.ts`,
  `src/pipeline-core/types.ts`, `src/pipeline/route-contract.ts`, `src/task-control-plane/task-control-plane-api.service.ts`,
  `src/mcp/mcp-tools.ts`, `src/mcp/mcp-capabilities.ts`,
  `control-plane/default-playbook/catalog/pipelines.json`
- **Related ADRs:** [ADR-0006](../adr/0006-run-profiles-and-provider-neutral-pipelines.md)
- **Related specs:** [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md),
  [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md),
  [default-playbook-policy.spec.md](./default-playbook-policy.spec.md),
  [runner-capabilities-v1.spec.md](./runner-capabilities-v1.spec.md),
  [runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md)

## Scope

This spec defines the public `RunProfile` contract for choosing runner/model bindings and profile-driven topology
overlays when launching `feature-development` runs.

It covers:

- stored and inline run profile shape;
- MCP profile discovery, validation, simulation, and launch behavior;
- provider-neutral pipeline slots;
- review consensus, proposal consensus, synthesis, and implementation-candidate patterns;
- replay/provenance pins.

It does not define:

- concrete provider model ids;
- provider pricing;
- runner process protocols beyond the existing runner specs;
- UI layout for profile editing.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / BCP 14.

## Current Contract

Current implementation is a partial substrate, not the final public contract.

Implemented pieces:

- `feature-development` is the reconciled default policy variant.
- The bundled catalog also contains `feature-development-codex-consensus` as an alias entry with
  `{ basePipelineId: "feature-development", profileId: "codex-consensus" }`.
- `CODEX_CONSENSUS_PROFILE` is a hardcoded `TopologyProfile` that toggles `planReviewer` and `codeReview` into
  two-branch fanout plus deterministic joins.
- `materializeTemplate` supports `TopologyProfile` with `toggles[]`, `fanout.branches`, `joinMode`,
  `verdictReducer`, and `merge` reducers.
- `create_run` and `simulate_route` accept optional `profileId` and optional `executionProfile`.
- Route decisions stamp `profileId`, `profileVersion`, `profileHash`, `materializedTemplateHash`,
  `materializerVersion`, and binding provenance when a topology profile is applied.
- `executionProfile` can override runner mapping, available runners, model level, timeout, and permission mode.

Current limitations:

- no inline public `profile` parameter;
- no requirement that `profileId` or inline `profile` be supplied;
- public MCP still exposes `executionProfile` as a separate concept;
- only `codex-consensus` is recognized as a stored topology profile;
- profile topology can only clone an existing agent into identical branches plus a join;
- branch lane bindings are not first-class profile data;
- `JoinArrival` records only branch id, sequence, and verdict, so post-join synthesis cannot consume a full branch
  output bundle;
- `feature-development-codex-consensus` remains a public pipeline alias for compatibility.

## Target Contract

### Terms

| Term | Meaning |
| --- | --- |
| Pipeline | Provider-neutral workflow graph such as `feature-development`. |
| Slot | Stable semantic binding name used by a pipeline stage, lane, or after-join node. |
| RunProfile | Versioned launch contract containing topology overlays plus runner/model bindings. |
| Lane | One branch inside a profile-created fanout stage. |
| Join | Deterministic runtime convergence node with explicit mode and reducers. |
| Merged output | Join output produced by merge reducers, without preserving every branch artifact as a full bundle. |
| After-join node | Agent, human gate, script, or choice that consumes a joined bundle or verdict. |
| Binding | Runner/model/permission/timeout/budget selection for a slot, lane, runner, or node. |
| Materialized graph | Pipeline template after applying the run profile topology overlay. |
| Capability snapshot | Runner/model/permission metadata used to validate the profile at launch. |

### Pipeline identity

The canonical default launch pipeline is `feature-development`.

Provider-specific and topology-specific variants MUST NOT be exposed as pipeline ids for new runs. A request using
`feature-development-codex-consensus` MUST fail before run creation with a migration diagnostic:

```json
{
  "code": "PIPELINE_ALIAS_REMOVED",
  "message": "Use pipelineId \"feature-development\" with profileId \"codex-consensus\"."
}
```

Existing stored runs that were created through the alias keep their pinned `requestedPipelineId` for audit.

### Base pipeline slots

The base pipeline owns workflow semantics, not provider selection. It SHOULD expose these stable slots, either
explicitly or by mapping current semantic role/node ids:

| Slot | Purpose |
| --- | --- |
| `analyst` | Produce the task plan or implementation proposal. |
| `analystSynthesis` | Synthesize multiple analysis proposals into one plan. |
| `planReview` | Review plan quality before the plan gate. |
| `developer` | Produce code changes. |
| `implementationSelector` | Select, combine, or adopt implementation candidates. |
| `codeReview` | Review produced code changes. |
| `triager` | Classify review/CI/recovery feedback. |
| `watcher` | Observe PR readiness and follow-up state. |
| `integrator` | Apply/push changes or perform repository integration. |
| `merger` | Confirm merge and cleanup after final readiness. |

Current-node mapping for the default bundled graph:

| Slot | Current node ids / notes |
| --- | --- |
| `analyst` | `analyst` |
| `planReview` | `planReviewer`; current `TopologyProfile` uses `baseName: "planReview"` when materializing fanout ids. |
| `developer` | `developer`, plus recovery/rework producers such as `reworkDeveloper`, `reviewRework`, `ciRework`, and `stuckReworkDeveloper`. |
| `codeReview` | `codeReview` |
| `triager` | `triage`, `triageRouter`, `classifyRecovery`, and `recoveryRouter` route triage/recovery decisions. |
| `watcher` | `pollPr`, `mergeReadiness`, `mergeRecheck`, and `mergeApproveReverify` perform PR/readiness observation. |
| `integrator` | `integrator`, `reviewIntegrator`, and `respondThreads` perform repository and review-thread integration. |
| `merger` | `confirmMerge` and `cleanupWorktree` perform final merge and cleanup. |

The pipeline MAY keep `roleRef` values such as `role:analyst` for playbook capability lookup, but those ids MUST NOT
encode concrete providers. Provider-specific role ids such as `reviewer-codex` should migrate to profile bindings or
seeded profile examples, not remain the canonical default pipeline shape.

### RunProfile shape

Examples use YAML for readability. The MCP and GraphQL transport shape is JSON with the same fields.

```yaml
schemaVersion: run-profile/v1
id: codex-standard
displayName: Codex standard
pipelineId: feature-development
description: Optional human-readable summary.
topology:
  stages:
    analyst:
      mode: single
    planReview:
      mode: single
    developer:
      mode: single
    codeReview:
      mode: single
bindings:
  slots:
    analyst:
      runnerId: codex
      modelLevel: deep
      permissionMode: workspace-write
    planReview:
      runnerId: codex
      modelLevel: deep
    developer:
      runnerId: codex
      modelLevel: standard
      permissionMode: workspace-write
    codeReview:
      runnerId: codex
      modelLevel: deep
    triager:
      runnerId: codex
      modelLevel: standard
    watcher:
      runnerId: codex
      modelLevel: cheap
    integrator:
      runnerId: revo-integrator
    merger:
      runnerId: revo-merger
```

Normative type shape:

```ts
type RunProfile = {
  schemaVersion: 'run-profile/v1';
  id?: string;
  displayName?: string;
  description?: string;
  pipelineId: 'feature-development';
  topology?: ProfileTopology;
  bindings: ProfileBindings;
  metadata?: Record<string, unknown>;
};

type ProfileTopology = {
  stages?: Record<string, StageOverlay>;
};

type StageOverlay =
  | { mode: 'single' }
  | ReviewConsensusStage
  | ProposalConsensusStage
  | ImplementationCandidatesStage;

type Lane = {
  id: string;
  slot: string;
  produces?: string;
};

type DeterministicJoin = {
  id?: string;
  joinMode: { kind: 'all' } | { kind: 'any' } | { kind: 'quorum'; count: number };
  verdictReducer?: {
    kind: 'allIn';
    pass: string[];
    passVerdict: string;
    failVerdict: string;
  };
  merge?: Record<string, 'overwrite' | 'appendByBranchOrder'>;
  output?: 'verdict' | 'merged' | 'bundle';
};

type AfterJoin =
  | { kind: 'agent'; id: string; slot: string; consumes: 'bundle' | 'verdict' | 'merged' }
  | { kind: 'humanGate'; id: string; reason: string; outcomes: string[]; consumes: 'bundle' | 'verdict' | 'merged' }
  | { kind: 'script'; id: string; scriptRef: string; consumes: 'bundle' | 'verdict' | 'merged' }
  | { kind: 'choice'; id: string; consumes: 'verdict' | 'merged' };

type ReviewConsensusStage = {
  mode: 'reviewConsensus';
  lanes: Lane[];
  join: DeterministicJoin & { output?: 'verdict' | 'merged' };
};

type ProposalConsensusStage = {
  mode: 'proposalConsensus';
  lanes: Lane[];
  join: DeterministicJoin & { output: 'bundle' };
  afterJoin: AfterJoin;
};

type ImplementationCandidatesStage = {
  mode: 'implementationCandidates';
  isolation: 'worktreePerLane';
  lanes: Lane[];
  join: DeterministicJoin & { output: 'bundle' };
  afterJoin: AfterJoin;
};

type ProfileBindings = {
  slots?: Record<string, Binding>;
  lanes?: Record<string, Binding>;
  nodes?: Record<string, Binding>;
  runners?: Record<string, Partial<Binding>>;
};

type Binding = {
  runnerId: string;
  modelLevel?: string;
  modelId?: string;
  permissionMode?: string;
  timeoutMs?: number;
  budget?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxCostUsd?: number;
  };
};
```

Validation rules:

- `schemaVersion` MUST be `run-profile/v1`.
- `pipelineId` MUST match the requested `pipelineId`.
- stage ids MUST resolve to base pipeline stages or approved insertion points.
- lane ids MUST be unique inside the profile.
- lane bindings MUST resolve either through `bindings.lanes[lane.id]` or `bindings.slots[lane.slot]`.
- all runner ids, model levels, concrete model ids, and permission modes MUST exist in the launch capability snapshot.
- `modelLevel` and `modelId` SHOULD be mutually exclusive unless the runner capability snapshot explicitly allows a
  concrete model inside a selected level.
- `implementationCandidates` MUST declare `isolation: "worktreePerLane"` and an explicit `afterJoin`.
- `proposalConsensus` and `implementationCandidates` MUST use `join.output: "bundle"`.
- omitted `join.output` defaults to `merged` when `merge` reducers are declared, otherwise `verdict`.
- `appendByBranchOrder` MUST use profile lane order, not physical completion order.
- unknown fields SHOULD fail closed once the profile schema is accepted.

### Topology and fanouts

`topology.stages` describes how a semantic stage changes before materialization:

- `single`: no fanout; one stage node uses the slot binding.
- `reviewConsensus`: parallel reviewers produce verdict/review artifacts, then a deterministic join reduces them.
- `proposalConsensus`: parallel proposal producers feed a joined bundle to an after-join synthesis/selection step.
- `implementationCandidates`: parallel developers work in isolated worktrees, then an after-join step selects,
  combines, or rejects candidates.

`fanout` is not an independent user-visible primitive in v1. It is the graph operation produced by a consensus or
candidate stage. The profile describes lanes; the materializer emits runtime `parallel` and `join` nodes.

`join` is the deterministic convergence primitive. It is not a custom script. Custom reasoning belongs in an
after-join node that consumes the deterministic join output.

### Bindings

Binding precedence:

1. `bindings.nodes[nodeId]`
2. `bindings.lanes[laneId]`
3. `bindings.slots[slot]`
4. `bindings.runners[runnerId]` partial defaults
5. playbook role defaults, if any

The route decision MUST record the source for every resolved field. Node and lane bindings can override runner id,
not just model/timeout/permission.

### MCP surface

`get_capabilities` MUST include a profile section:

```json
{
  "profiles": {
    "requiredForCreateRun": true,
    "requiredForSimulateRoute": true,
    "acceptedSources": ["profileId", "profile"],
    "schemaVersion": "run-profile/v1",
    "tools": [
      "list_profiles",
      "get_profile",
      "get_profile_schema",
      "list_runner_capabilities",
      "validate_profile",
      "create_profile",
      "update_profile",
      "simulate_route",
      "create_run"
    ],
    "removedPipelineAliases": {
      "feature-development-codex-consensus": {
        "pipelineId": "feature-development",
        "profileId": "codex-consensus"
      }
    }
  }
}
```

Required MCP tools:

| Tool | Purpose |
| --- | --- |
| `list_profiles` | Return stored seeded/user profiles with id, version, pipelineId, summary, and hash. |
| `get_profile` | Return one stored profile, optionally including full JSON. |
| `get_profile_schema` | Return JSON Schema, examples, and accepted stage modes. |
| `list_runner_capabilities` | Return available runners, model levels, model ids, permission modes, and capability flags. |
| `validate_profile` | Validate a stored or inline profile against a pipeline and capability snapshot without creating a run. |
| `create_profile` | Validate and store a reusable versioned profile, returning `profileId`, `version`, and `profileHash`. |
| `update_profile` | Create a new immutable version of an existing stored profile. Old versions remain replayable. |
| `simulate_route` | Materialize graph and resolved bindings without creating a run. |
| `create_run` | Create a run only after profile source validation succeeds. |

Stored profile lifecycle:

- `create_profile` validates the profile against the current schema and runner capability snapshot, stores the
  normalized profile as versioned meaning, and returns a stable id plus a content hash.
- `update_profile` never mutates historical versions in place. It writes a new version/hash so existing runs can keep
  replaying from their pinned snapshot.
- `create_run` may reference a stored `profileId` or carry an inline `profile`. Inline profiles do not need to be
  reusable stored rows, but they still get normalized, hashed, and pinned in the run.

`create_run` and `simulate_route` are feature-service front doors. Both MUST resolve and validate a profile source
before materializing a route. MCP, GraphQL, and tests should share that feature-service invariant; transport-specific
schemas can differ only during the compatibility migration.

`create_run` target input:

```ts
type CreateRunInput = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  playbookId?: string;
  pipelineId: 'feature-development';
  profileId?: string;
  profile?: RunProfile;
  params?: Record<string, unknown>;
  issueRef?: { repo: string; number: number; url: string };
  issueAction?: 'close' | 'refs' | 'none';
  priority?: number;
  start?: boolean;
};
```

`simulate_route` target input:

```ts
type SimulateRouteInput = {
  title: string;
  repo?: string;
  playbookId?: string;
  pipelineId: 'feature-development';
  profileId?: string;
  profile?: RunProfile;
  params?: Record<string, unknown>;
  includeDetails?: boolean;
};
```

Rules for both `create_run` and `simulate_route`:

- exactly one of `profileId` or `profile` MUST be supplied;
- `executionProfile` MUST NOT be part of the public MCP route/launch shape once this contract is implemented;
- missing profile MUST return `confirmationRequired` or `validationRequired` style data with no run creation;
- inline `profile` MUST be normalized, hashed, and persisted into the route decision snapshot even if not stored as a
  reusable profile;
- `profileId` MUST resolve to a versioned profile row and the selected version/hash MUST be pinned.

Missing-profile response example:

```json
{
  "confirmationRequired": true,
  "reason": "profile_required",
  "message": "create_run requires profileId or inline profile.",
  "pipelineId": "feature-development",
  "runnerCapabilitySummary": {
    "tool": "list_runner_capabilities",
    "availableRunnerIds": ["codex", "claude-code", "revo-integrator", "revo-merger"],
    "truncated": true
  },
  "candidateProfiles": [
    { "profileId": "codex-standard", "pipelineId": "feature-development", "summary": "All agent slots use Codex." },
    { "profileId": "claude-standard", "pipelineId": "feature-development", "summary": "All agent slots use Claude Code." },
    { "profileId": "codex-claude-review-consensus", "pipelineId": "feature-development", "summary": "Codex development with Claude+Codex review consensus." }
  ],
  "nextTools": ["list_profiles", "get_profile_schema", "list_runner_capabilities", "validate_profile", "create_profile"]
}
```

### Replay pins

Run creation MUST persist these fields in `route_decision` or an equivalent immutable route pin:

```ts
type ProfileRoutePin = {
  profileSource: 'stored' | 'inline';
  profileId?: string;
  profileVersion?: string;
  profileHash: string;
  profileSnapshot: RunProfile;
  runnerCapabilitySnapshot: unknown;
  playbookVersion: string;
  basePipelineId: 'feature-development';
  basePipelineVersion: string;
  materializerVersion: string;
  materializedTemplateHash: string;
  materializedTemplate: unknown;
  resolvedBindings: Array<{
    nodeId?: string;
    laneId?: string;
    slot: string;
    runnerId: string;
    modelLevel?: string;
    modelId?: string;
    permissionMode?: string;
    timeoutMs?: number;
    // Keys are resolved field names such as runnerId, modelLevel, modelId, permissionMode, and timeoutMs.
    sources: Record<string, 'profile-node' | 'profile-lane' | 'profile-slot' | 'profile-runner' | 'playbook'>;
  }>;
};
```

Recovery and replay MUST read the pinned snapshot and graph. Updating a stored profile affects only new runs.

## Target Migration

1. Keep current `TopologyProfile` and `executionProfile` tests as regression coverage for the substrate.
2. Add `RunProfile` parser/validator with closed-schema diagnostics.
3. Add runner capability discovery to MCP and route simulation.
4. Teach materialization to create lanes, lane bindings, after-join nodes, and bundle-producing joins.
5. Pin the full profile snapshot and capability snapshot in route decisions.
6. Add public MCP profile tools and update `get_capabilities`.
7. Require `profileId` or `profile` for `create_run` / `simulate_route`.
8. Stop listing `feature-development-codex-consensus` as a launchable public pipeline; keep read-only migration
   diagnostics and replay compatibility.
9. Migrate seeded examples from provider-specific catalog variants into stored run profiles.

## Validation

Required tests:

- schema rejects unknown top-level fields, unknown stage modes, duplicate lane ids, unresolved slots, and invalid
  binding targets;
- capability validation rejects unknown runners, model levels, model ids, and permission modes;
- missing profile returns a no-run-created MCP response with candidate profiles and next tools;
- both stored `profileId` and inline `profile` launches pin identical graph/binding data when their content matches;
- changing a stored profile after run creation does not change replay, recovery, run digest, or route simulation for
  the existing run;
- review consensus preserves deterministic branch order in merged artifacts;
- proposal consensus exposes a branch-output bundle to an after-join synthesis agent;
- implementation candidates run in separate worktrees and require explicit adoption/selection before integration;
- legacy alias requests produce the migration diagnostic and no new run;
- `get_capabilities` and `list_runner_capabilities` expose enough metadata for an MCP client to construct a valid
  profile without reading source code.

Manual verification before accepting the spec:

- run one all-Codex profile against a small local repository;
- run one all-Claude profile against the same repository;
- run one review-consensus profile where plan review and code review have at least two lanes;
- run one proposal-consensus profile where `analystSynthesis` consumes the branch bundle;
- run one implementation-candidate profile through human selection/adoption.

## Compatibility

- Existing runs keep their stored route decisions and can be inspected/replayed with their original pins.
- The legacy alias can remain readable for old runs but MUST NOT be recommended by MCP or docs for new runs.
- GraphQL and test seams MAY keep `executionProfile` temporarily, but the feature-service create/simulate path should
  still enforce the profile source invariant once this contract is implemented. MCP should move clients to `profile`.
- Stored seeded profile ids are stable only within a profile version. Changing profile behavior requires a new version
  and hash.
- Inline profiles are immutable per run and do not need a reusable stored id.

## Examples

These examples are illustrative. Actual `runnerId`, `modelLevel`, `modelId`, and `permissionMode` values MUST come from
`list_runner_capabilities`.

### All Codex

```yaml
schemaVersion: run-profile/v1
id: codex-standard
pipelineId: feature-development
topology:
  stages:
    analyst: { mode: single }
    planReview: { mode: single }
    developer: { mode: single }
    codeReview: { mode: single }
bindings:
  slots:
    analyst: { runnerId: codex, modelLevel: deep, permissionMode: workspace-write }
    planReview: { runnerId: codex, modelLevel: deep }
    developer: { runnerId: codex, modelLevel: standard, permissionMode: workspace-write }
    codeReview: { runnerId: codex, modelLevel: deep }
    triager: { runnerId: codex, modelLevel: standard }
    watcher: { runnerId: codex, modelLevel: cheap }
    integrator: { runnerId: revo-integrator }
    merger: { runnerId: revo-merger }
```

### All Claude

```yaml
schemaVersion: run-profile/v1
id: claude-standard
pipelineId: feature-development
topology:
  stages:
    analyst: { mode: single }
    planReview: { mode: single }
    developer: { mode: single }
    codeReview: { mode: single }
bindings:
  slots:
    analyst: { runnerId: claude-code, modelLevel: deep, permissionMode: acceptEdits }
    planReview: { runnerId: claude-code, modelLevel: deep }
    developer: { runnerId: claude-code, modelLevel: standard, permissionMode: acceptEdits }
    codeReview: { runnerId: claude-code, modelLevel: deep }
    triager: { runnerId: claude-code, modelLevel: standard }
    watcher: { runnerId: claude-code, modelLevel: cheap }
    integrator: { runnerId: revo-integrator }
    merger: { runnerId: revo-merger }
```

### Codex Development, Claude plus Codex Review Consensus

```yaml
schemaVersion: run-profile/v1
id: codex-claude-review-consensus
pipelineId: feature-development
topology:
  stages:
    analyst: { mode: single }
    developer: { mode: single }
    planReview:
      mode: reviewConsensus
      lanes:
        - { id: planReviewCodex, slot: planReview }
        - { id: planReviewClaude, slot: planReview }
      join:
        joinMode: { kind: all }
        verdictReducer:
          kind: allIn
          pass: [approved, clean]
          passVerdict: approved
          failVerdict: changes_requested
        merge: { reviews: appendByBranchOrder }
    codeReview:
      mode: reviewConsensus
      lanes:
        - { id: codeReviewCodex, slot: codeReview }
        - { id: codeReviewClaude, slot: codeReview }
      join:
        joinMode: { kind: all }
        verdictReducer:
          kind: allIn
          pass: [approved, clean]
          passVerdict: approved
          failVerdict: changes_requested
        merge: { reviews: appendByBranchOrder }
bindings:
  slots:
    analyst: { runnerId: codex, modelLevel: deep, permissionMode: workspace-write }
    developer: { runnerId: codex, modelLevel: standard, permissionMode: workspace-write }
    triager: { runnerId: codex, modelLevel: standard }
    watcher: { runnerId: codex, modelLevel: cheap }
    integrator: { runnerId: revo-integrator }
    merger: { runnerId: revo-merger }
  lanes:
    planReviewCodex: { runnerId: codex, modelLevel: deep }
    planReviewClaude: { runnerId: claude-code, modelLevel: deep }
    codeReviewCodex: { runnerId: codex, modelLevel: deep }
    codeReviewClaude: { runnerId: claude-code, modelLevel: deep }
```

### Codex, Claude, and OpenCode Analysis Consensus

This profile runs three analysis lanes, joins their proposal bundle, then asks a synthesis agent to produce the one
plan that flows into plan review.

```yaml
schemaVersion: run-profile/v1
id: analytics-codex-claude-opencode
pipelineId: feature-development
topology:
  stages:
    analyst:
      mode: proposalConsensus
      lanes:
        - { id: analystCodex, slot: analyst, produces: planCandidate }
        - { id: analystClaude, slot: analyst, produces: planCandidate }
        - { id: analystOpenCode, slot: analyst, produces: planCandidate }
      join:
        id: analystJoin
        joinMode: { kind: all }
        output: bundle
      afterJoin:
        kind: agent
        id: analystSynthesis
        slot: analystSynthesis
        consumes: bundle
    planReview: { mode: single }
    developer: { mode: single }
    codeReview: { mode: single }
bindings:
  lanes:
    analystCodex: { runnerId: codex, modelLevel: deep, permissionMode: workspace-write }
    analystClaude: { runnerId: claude-code, modelLevel: deep, permissionMode: acceptEdits }
    analystOpenCode: { runnerId: opencode, modelLevel: deep, permissionMode: workspace-write }
  slots:
    analystSynthesis: { runnerId: codex, modelLevel: deep, permissionMode: workspace-write }
    planReview: { runnerId: claude-code, modelLevel: deep }
    developer: { runnerId: codex, modelLevel: standard, permissionMode: workspace-write }
    codeReview: { runnerId: claude-code, modelLevel: deep }
    triager: { runnerId: codex, modelLevel: standard }
    watcher: { runnerId: codex, modelLevel: cheap }
    integrator: { runnerId: revo-integrator }
    merger: { runnerId: revo-merger }
```

Runtime graph shape:

```text
analystCodex
analystClaude
analystOpenCode
       |
       v
analystJoin
       |
       v
analystSynthesis
       |
       v
planReview
```

### Codex and OpenCode Implementation Candidates

This profile creates two isolated development candidates, then uses a human gate to choose, rework, or cancel before
integration. A profile that needs automatic combination should use an agent or script after-join node instead of this
human-selection example.

```yaml
schemaVersion: run-profile/v1
id: developer-codex-opencode-candidates
pipelineId: feature-development
topology:
  stages:
    analyst: { mode: single }
    planReview: { mode: single }
    developer:
      mode: implementationCandidates
      isolation: worktreePerLane
      lanes:
        - { id: developerCodex, slot: developer, produces: changeCandidate }
        - { id: developerOpenCode, slot: developer, produces: changeCandidate }
      join:
        id: developerJoin
        joinMode: { kind: all }
        output: bundle
      afterJoin:
        kind: humanGate
        id: implementationSelectionGate
        reason: choose_implementation_candidate
        outcomes: [adopt_codex, adopt_opencode, rework, cancel]
        consumes: bundle
    codeReview:
      mode: reviewConsensus
      lanes:
        - { id: codeReviewCodex, slot: codeReview }
        - { id: codeReviewOpenCode, slot: codeReview }
      join:
        joinMode: { kind: all }
        verdictReducer:
          kind: allIn
          pass: [approved, clean]
          passVerdict: approved
          failVerdict: changes_requested
        merge: { reviews: appendByBranchOrder }
bindings:
  slots:
    analyst: { runnerId: codex, modelLevel: deep, permissionMode: workspace-write }
    planReview: { runnerId: codex, modelLevel: deep }
    triager: { runnerId: codex, modelLevel: standard }
    watcher: { runnerId: codex, modelLevel: cheap }
    integrator: { runnerId: revo-integrator }
    merger: { runnerId: revo-merger }
  lanes:
    developerCodex: { runnerId: codex, modelLevel: standard, permissionMode: workspace-write }
    developerOpenCode: { runnerId: opencode, modelLevel: standard, permissionMode: workspace-write }
    codeReviewCodex: { runnerId: codex, modelLevel: deep }
    codeReviewOpenCode: { runnerId: opencode, modelLevel: deep }
```

### Inline MCP Launch

```json
{
  "title": "Implement CSV import validation",
  "repo": "/path/to/revo-example",
  "pipelineId": "feature-development",
  "profile": {
    "schemaVersion": "run-profile/v1",
    "pipelineId": "feature-development",
    "topology": {
      "stages": {
        "analyst": { "mode": "single" },
        "planReview": { "mode": "single" },
        "developer": { "mode": "single" },
        "codeReview": { "mode": "single" }
      }
    },
    "bindings": {
      "slots": {
        "analyst": { "runnerId": "codex", "modelLevel": "deep", "permissionMode": "workspace-write" },
        "planReview": { "runnerId": "codex", "modelLevel": "deep" },
        "developer": { "runnerId": "codex", "modelLevel": "standard", "permissionMode": "workspace-write" },
        "codeReview": { "runnerId": "codex", "modelLevel": "deep" },
        "integrator": { "runnerId": "revo-integrator" },
        "merger": { "runnerId": "revo-merger" }
      }
    }
  },
  "start": true
}
```

## Changelog

- 2026-07-03: Initial draft for explicit run profiles, provider-neutral `feature-development`, MCP profile
  ergonomics, replay pins, and consensus examples.
