import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_WATCH_CURSOR_CHARS } from '../task-control-plane/run-watch.service.js';
import { OPERATOR_MONITORING_PROTOCOL } from './monitoring-directive.js';
import type { McpFacadeService } from './mcp-facade.service.js';

function json(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const runIdSchema = z.string().min(1).describe('Run ID');
const inboxIdSchema = z.string().min(1).describe('Inbox item ID');
const limitSchema = z.number().int().positive().max(500).optional();
const agentOutputLimitSchema = z.number().int().positive().max(1000).optional().default(100);
const agentStreamSchema = z.enum(['stdout', 'stderr', 'events', 'combined']);
const agentLogByteSchema = z.number().int().positive().max(1048576).optional();
const agentLogOffsetSchema = z.number().int().nonnegative().max(1048576).optional();
const paramsSchema = z.record(z.string(), z.unknown()).optional();
const manualAdoptionAuditSchema = z.object({
  runId: z.string().trim().min(1),
  step: z.string().trim().min(1),
  role: z.string().trim().min(1),
  targetRepo: z.string().trim().min(1),
  targetBranch: z.string().trim().min(1),
  actor: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  risk: z.string().trim().min(1),
  verificationResponsibility: z.string().trim().min(1),
  artifactRef: z.string().trim().min(1).optional(),
  worktreeRef: z.string().trim().min(1).optional(),
}).refine((value) => value.artifactRef !== undefined || value.worktreeRef !== undefined, {
  message: 'artifactRef or worktreeRef is required',
});

const mergeOverrideAuditSchema = z.object({
  threadIds: z.array(z.string().trim().min(1)).min(1),
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  risk: z.string().trim().min(1),
  verificationResponsibility: z.string().trim().min(1),
  headSha: z.string().trim().min(1),
  fingerprint: z.string().trim().min(1).optional(),
});
const issueRefSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
}).optional();
const watchCursorSchema = z.string().max(MAX_WATCH_CURSOR_CHARS);
const prReadinessInputSchema = {
  repo: z.string().min(1).describe('GitHub repository in owner/name form, for example revisium/agent-orchestrator'),
  prNumber: z.number().int().positive().optional(),
  headBranch: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional().default('master'),
  sonarProject: z.string().min(1).optional(),
  issueRef: issueRefSchema,
  includeComments: z.boolean().optional().default(true),
  includeReviewThreads: z.boolean().optional().default(true),
};


function assertValidAgentLogRange(input: { offsetBytes?: number; limitBytes?: number; tailBytes?: number }): void {
  if (input.tailBytes !== undefined && (input.offsetBytes !== undefined || input.limitBytes !== undefined)) {
    throw new Error('VALIDATION_FAILURE: tailBytes cannot be combined with offsetBytes or limitBytes');
  }
}

function assertValidResolveGateInput(input: { outcome: string; adoptionAudit?: unknown; mergeOverrideAudit?: unknown }): void {
  if (input.outcome.trim() === 'adopt_patch_manually') {
    const parsed = manualAdoptionAuditSchema.safeParse(input.adoptionAudit);
    if (!parsed.success) {
      throw new Error(`VALIDATION_FAILURE: adopt_patch_manually requires complete adoptionAudit (${parsed.error.issues[0]?.message ?? 'invalid'})`);
    }
    return;
  }
  if (input.outcome.trim() === 'override_merge') {
    const parsed = mergeOverrideAuditSchema.safeParse(input.mergeOverrideAudit);
    if (!parsed.success) {
      throw new Error(`VALIDATION_FAILURE: override_merge requires complete mergeOverrideAudit (${parsed.error.issues[0]?.message ?? 'invalid'})`);
    }
  }
}

export function registerRevoMcpTools(server: McpServer, facade: McpFacadeService): void {
  server.registerTool(
    'get_status',
    {
      description: 'Return local daemon, DBOS host, and control-plane project status.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await facade.getStatus()),
  );

  server.registerTool(
    'doctor',
    {
      description: 'Run lightweight local diagnostics for the Revo control plane.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await facade.doctor()),
  );

  server.registerTool(
    'get_capabilities',
    {
      description: 'List supported Revo MCP tools and execution modes.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => json(facade.getCapabilities()),
  );

  server.registerTool(
    'validate_repository',
    {
      description: 'Validate a repository path before starting live development work.',
      inputSchema: {
        repo: z.string().min(1).describe('Repository path to validate'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo }) => json(await facade.validateRepository(repo)),
  );

  server.registerTool(
    'get_repository_context',
    {
      description: 'Return repository validation plus known local guidance files and package scripts.',
      inputSchema: {
        repo: z.string().min(1).describe('Repository path to inspect'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo }) => json(await facade.getRepositoryContext(repo)),
  );

  server.registerTool(
    'get_project',
    {
      description: 'Return the configured local Revo control-plane project binding.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => json(facade.getProject()),
  );

  server.registerTool(
    'create_run',
    {
      description: 'Create a development run, optionally starting the pipeline immediately. An explicit pipelineId is required: omitting it returns confirmationRequired with candidatePipelines and a best-effort wouldAutoRoute so you can choose and re-call — no run is created.',
      inputSchema: {
        title: z.string().min(1),
        repo: z.string().min(1),
        description: z.string().optional(),
        scope: z.string().optional(),
        playbookId: z.string().min(1).optional(),
        pipelineId: z.string().min(1).optional().describe('Required: the pipeline to use. Omit to receive candidatePipelines for selection (no run is created).'),
        params: paramsSchema,
        issueRef: issueRefSchema,
        priority: z.number().int().optional(),
        start: z.boolean().optional().describe('Start the workflow immediately after creating the run'),
        includeMonitoringGuidance: z.boolean().optional().describe('Set false to suppress the operator monitoring directive in the response. Default: true.'),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.createRun(input)),
  );

  server.registerTool(
    'start_run',
    {
      description:
        'Start or reattach the durable pipeline workflow for an existing run. For a terminal recoverable preflight block, returns nextAction:"resume_run" without retrying or creating recovery.',
      inputSchema: {
        runId: runIdSchema,
        includeMonitoringGuidance: z.boolean().optional().describe('Set false to suppress the operator monitoring directive in the response. Default: true.'),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.startRun(input)),
  );

  server.registerTool(
    'resume_run',
    {
      description:
        'Resume an existing run. If the run is a terminal recoverable preflight block, creates or reuses a follow-up recovery run, returns the child runId, and starts/observes that child workflow.',
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.resumeRun(input)),
  );

  server.registerTool(
    'get_run_attention',
    {
      description:
        `Default/primary tool for agents monitoring a run: answers "what currently requires attention?" Single-shot, no cursor. ${OPERATOR_MONITORING_PROTOCOL.join(' ')}`,
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => json(await facade.getRunAttention(runId)),
  );

  server.registerTool(
    'get_run_status',
    {
      description:
        'Return neutral current run state for dashboards and status checks. Does not prescribe actions.',
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => json(await facade.getRunStatus(runId)),
  );

  server.registerTool(
    'watch_run_changes',
    {
      description:
        'Not for normal task monitoring — use get_run_attention. Advanced bounded long-poll for UI/change-stream/long-poll consumers that explicitly need cursor-based transition delivery: blocks until an actionable or terminal transition, returns a resume cursor; re-call with the cursor to continue without re-delivering prior transitions.',
      inputSchema: {
        runId: runIdSchema,
        cursor: watchCursorSchema.optional().describe('Resume cursor from a prior call'),
        timeoutMs: z.number().int().nonnegative().max(45000).optional().describe('Server hold (clamped ≤45s)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => json(await facade.watchRunChanges({ ...input, signal: extra?.signal })),
  );

  server.registerTool(
    'cancel_run',
    {
      description: 'Cancel a run and append a run_cancelled event.',
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ runId }) => json(await facade.cancelRun(runId)),
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List known development runs.',
      inputSchema: {
        status: z.string().optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.listRuns(input)),
  );

  server.registerTool(
    'get_run',
    {
      description:
        'Diagnostic tool: show a run with tasks and steps; can include bounded events and attempt summaries. Avoid includeEvents in polling loops; prefer get_run_attention and get_run_digest.',
      inputSchema: {
        runId: runIdSchema,
        includeEvents: z.boolean().optional(),
        includeLog: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.getRun(input)),
  );

  server.registerTool(
    'get_run_events',
    {
      description: 'List events for a run.',
      inputSchema: {
        runId: runIdSchema,
        type: z.string().optional(),
        limit: limitSchema,
        expand: z.array(z.enum(['graph'])).optional().describe('Pass ["graph"] to include the full run_created graph payload instead of the compact summary.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.getRunEvents(input)),
  );

  server.registerTool(
    'get_run_log',
    {
      description: 'List per-attempt observability rows for a run.',
      inputSchema: {
        runId: runIdSchema,
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.getRunLog(input)),
  );

  server.registerTool(
    'get_agent_activity',
    {
      description: 'Return current agent activity for a run, or null when no activity exists.',
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => json(await facade.getAgentActivity(runId)),
  );

  server.registerTool(
    'get_agent_attempts',
    {
      description: 'List agent attempt artifact summaries for a run.',
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => json(await facade.getAgentAttempts(runId)),
  );

  server.registerTool(
    'get_agent_log',
    {
      description: 'Read bounded agent log content for a run attempt.',
      inputSchema: {
        runId: runIdSchema,
        attemptId: z.string().min(1).optional(),
        stream: agentStreamSchema,
        offsetBytes: agentLogOffsetSchema,
        limitBytes: agentLogByteSchema,
        tailBytes: agentLogByteSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      assertValidAgentLogRange(input);
      return json(await facade.getAgentLog(input));
    },
  );

  server.registerTool(
    'tail_agent_log',
    {
      description: 'Read one finite page of agent output events. Poll with nextCursor; this is not a subscription.',
      inputSchema: {
        runId: runIdSchema,
        cursor: z.string().min(1).optional(),
        limit: agentOutputLimitSchema,
        timeoutMs: z.number().int().positive().optional().default(250),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.tailAgentLog(input)),
  );

  server.registerTool(
    'read_agent_output_events',
    {
      description: 'Read a bounded run-global page of agent output events.',
      inputSchema: {
        runId: runIdSchema,
        cursor: z.string().min(1).optional(),
        limit: agentOutputLimitSchema,
        timeoutMs: z.number().int().positive().optional().default(250),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.readAgentOutputEvents(input)),
  );

  server.registerTool(
    'get_run_digest',
    {
      description: 'Return a compact run summary with pending decisions, latest events, and usage totals.',
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => json(await facade.getRunDigest(runId)),
  );

  server.registerTool(
    'list_inbox',
    {
      description: 'List human inbox items, optionally filtered by run and status.',
      inputSchema: {
        status: z.enum(['pending', 'resolved']).optional(),
        runId: z.string().optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.listInbox(input)),
  );

  server.registerTool(
    'get_inbox_item',
    {
      description: 'Show a single inbox item.',
      inputSchema: {
        inboxId: inboxIdSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ inboxId }) => json(await facade.getInboxItem(inboxId)),
  );

  server.registerTool(
    'get_pending_decisions',
    {
      description: 'List pending inbox decisions, optionally scoped to a run.',
      inputSchema: {
        runId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) => json(await facade.getPendingDecisions(runId)),
  );

  server.registerTool(
    'approve_gate',
    {
      description: 'Approve a plan or merge gate and signal the parked workflow.',
      inputSchema: {
        inboxId: inboxIdSchema,
        resolvedBy: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.approveGate(input)),
  );

  server.registerTool(
    'reject_gate',
    {
      description: 'Reject a plan or merge gate and signal the parked workflow.',
      inputSchema: {
        inboxId: inboxIdSchema,
        resolvedBy: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.rejectGate(input)),
  );

  server.registerTool(
    'resolve_gate',
    {
      description: 'Resolve a gate with an explicit named outcome and optional human note.',
      inputSchema: {
        inboxId: inboxIdSchema,
        outcome: z.string().min(1),
        note: z.string().optional(),
        resolvedBy: z.string().optional(),
        adoptionAudit: manualAdoptionAuditSchema.optional(),
        mergeOverrideAudit: mergeOverrideAuditSchema.optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => {
      assertValidResolveGateInput(input);
      return json(await facade.resolveGate(input));
    },
  );

  server.registerTool(
    'answer_question',
    {
      description: 'Answer a non-gate inbox question or alert.',
      inputSchema: {
        inboxId: inboxIdSchema,
        answer: z.unknown(),
        resolvedBy: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.answerQuestion(input)),
  );

  server.registerTool(
    'resolve_inbox_item',
    {
      description: 'Resolve an inbox item with an arbitrary answer; gate items are signaled by default.',
      inputSchema: {
        inboxId: inboxIdSchema,
        answer: z.unknown(),
        resolvedBy: z.string().optional(),
        signalGate: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.resolveInboxItem(input)),
  );

  server.registerTool(
    'summarize_gate_risk',
    {
      description: 'Summarize the risk and context for an inbox gate or question.',
      inputSchema: {
        inboxId: inboxIdSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ inboxId }) => json(await facade.summarizeGateRisk(inboxId)),
  );

  server.registerTool(
    'install_playbook',
    {
      description: 'Install a local/package playbook manifest into the control plane.',
      inputSchema: {
        source: z.string().min(1),
        commit: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        name: z.string().optional(),
        version: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.installPlaybook(input)),
  );

  server.registerTool(
    'list_playbooks',
    {
      description: 'List installed playbooks.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await facade.listPlaybooks()),
  );

  server.registerTool(
    'list_roles',
    {
      description: 'List installed role summaries.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await facade.listRoles()),
  );

  server.registerTool(
    'get_role',
    {
      description: 'Load a role definition by role ID.',
      inputSchema: {
        roleId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ roleId }) => json(await facade.getRole(roleId)),
  );

  server.registerTool(
    'list_pipelines',
    {
      description: 'List installed pipeline summaries. Compact by default; pass includeDetails:true only for execution policy graph/debugging.',
      inputSchema: {
        includeDetails: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.listPipelines(input)),
  );

  server.registerTool(
    'get_pipeline',
    {
      description: 'Load an installed pipeline by row ID. Compact by default; pass includeDetails:true only for execution policy graph/debugging.',
      inputSchema: {
        pipelineId: z.string().min(1),
        includeDetails: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.getPipeline(input)),
  );

  server.registerTool(
    'simulate_route',
    {
      description: 'Return the current advisory route for a task without creating a run. Compact by default; pass includeDetails:true only for route graph/debugging.',
      inputSchema: {
        title: z.string().min(1),
        repo: z.string().optional(),
        pipeline: z.string().optional(),
        playbookId: z.string().optional(),
        params: paramsSchema,
        includeDetails: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.simulateRoute(input)),
  );

  server.registerTool(
    'get_pr_readiness',
    {
      description: 'Return normalized read-only PR readiness from GitHub checks, reviews, review threads, provider comments, and optional Sonar data.',
      inputSchema: prReadinessInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.getPrReadiness(input)),
  );

  server.registerTool(
    'list_pr_feedback',
    {
      description: 'Return the actionable PR feedback queue grouped by developer fixes, reviewer questions, provider waits, human decisions, ignored noise, and residual risks. Provider-wait items carry a `blocking` flag and a `nature` of "informational" (stale comment) or "blocking" (live pending check).',
      inputSchema: prReadinessInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.listPrFeedback(input)),
  );
}
