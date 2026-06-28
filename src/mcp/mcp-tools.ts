import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_WATCH_CURSOR_CHARS } from '../task-control-plane/run-watch.service.js';
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
const issueRefSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
}).optional();
const watchCursorSchema = z.string().max(MAX_WATCH_CURSOR_CHARS);
const observeRunModeSchema = z.enum(['actionable', 'heartbeat', 'diagnostic']);
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

const watchInputSchema = {
  runIds: z.array(z.string().min(1)).min(1).max(50).optional().describe('Runs to watch; omit to watch all active runs'),
  timeoutMs: z.number().int().nonnegative().max(45000).optional().describe('Server hold (clamped ≤45s)'),
  cursor: watchCursorSchema.optional().describe('Resume cursor from a prior call; suppresses already-delivered transitions'),
};
const observeRunInputSchema = {
  runId: runIdSchema,
  cursor: watchCursorSchema.optional().describe('Resume cursor from a prior observe_run call'),
  mode: observeRunModeSchema.optional().describe('Observation mode: actionable by default, heartbeat for liveness, diagnostic for bounded hints'),
  timeoutMs: z.number().int().nonnegative().max(45000).optional().describe('Server hold (clamped ≤45s)'),
  heartbeatEveryMs: z.number().int().positive().max(45000).optional().describe('Heartbeat cadence for mode:"heartbeat" (clamped ≤45s)'),
};

function assertValidAgentLogRange(input: { offsetBytes?: number; limitBytes?: number; tailBytes?: number }): void {
  if (input.tailBytes !== undefined && (input.offsetBytes !== undefined || input.limitBytes !== undefined)) {
    throw new Error('VALIDATION_FAILURE: tailBytes cannot be combined with offsetBytes or limitBytes');
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
      description: 'Create a development run, optionally starting the pipeline immediately.',
      inputSchema: {
        title: z.string().min(1),
        repo: z.string().min(1),
        description: z.string().optional(),
        scope: z.string().optional(),
        playbookId: z.string().min(1).optional(),
        pipelineId: z.string().min(1).optional(),
        params: paramsSchema,
        issueRef: issueRefSchema,
        priority: z.number().int().optional(),
        start: z.boolean().optional().describe('Start the workflow immediately after creating the run'),
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
    'observe_run',
    {
      description:
        'Canonical low-context run observation. Use with the returned cursor for normal polling; returns compact state, transition, heartbeat/activity counters, and the next bounded action without raw logs or full events.',
      inputSchema: observeRunInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => json(await facade.observeRun({ ...input, signal: extra?.signal })),
  );

  server.registerTool(
    'wait_for_run',
    {
      description:
        'Compatibility/diagnostic tool: resolve current run state and next action. Prefer observe_run with cursor for normal observation loops.',
      inputSchema: {
        runId: runIdSchema,
        timeoutMs: z.number().int().nonnegative().max(45000).optional(),
        intervalMs: z.number().int().positive().max(10000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.waitForRun(input)),
  );

  server.registerTool(
    'wait_for_any_gate',
    {
      description:
        'Compatibility/diagnostic bounded long-poll: block until ANY watched run hits an approval/question gate, returning the gate (with its inbox row) and a resume cursor. Prefer observe_run for normal observation loops. Omit runIds to watch all active runs (capped).',
      inputSchema: watchInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => json(await facade.waitForAnyGate({ ...input, signal: extra?.signal })),
  );

  server.registerTool(
    'watch_runs',
    {
      description:
        'Compatibility/diagnostic bounded long-poll: surfaces gate, terminal, failed, and blocked transitions. Prefer observe_run for normal observation loops. Returns {transitions, cursor, timedOut}; re-call with the cursor to continue.',
      inputSchema: watchInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => json(await facade.watchRuns({ ...input, signal: extra?.signal })),
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
        'Diagnostic tool: show a run with tasks and steps; can include bounded events and attempt summaries. Avoid includeEvents in polling loops; prefer observe_run and get_run_digest.',
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
