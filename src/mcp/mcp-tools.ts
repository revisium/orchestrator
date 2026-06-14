import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
const paramsSchema = z.record(z.string(), z.unknown()).optional();
const prReadinessInputSchema = {
  repo: z.string().min(1).describe('GitHub repository in owner/name form, for example revisium/agent-orchestrator'),
  prNumber: z.number().int().positive().optional(),
  headBranch: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional().default('master'),
  sonarProject: z.string().min(1).optional(),
  includeComments: z.boolean().optional().default(true),
  includeReviewThreads: z.boolean().optional().default(true),
};

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
      description: 'Start or reattach the durable pipeline workflow for an existing run.',
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
      description: 'Alias for start_run; reattaches a durable workflow by run ID.',
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: false },
    },
    async (input) => json(await facade.resumeRun(input)),
  );

  server.registerTool(
    'wait_for_run',
    {
      description: 'Resolve current run state and next action: pending_gate, question, running, blocked, failed, completed.',
      inputSchema: {
        runId: runIdSchema,
        timeoutMs: z.number().int().nonnegative().max(120000).optional(),
        intervalMs: z.number().int().positive().max(10000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.waitForRun(input)),
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
      description: 'Show a run with tasks and steps; can include events and attempt log.',
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
      description: 'List installed pipeline summaries.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await facade.listPipelines()),
  );

  server.registerTool(
    'get_pipeline',
    {
      description: 'Load an installed pipeline by row ID.',
      inputSchema: {
        pipelineId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pipelineId }) => json(await facade.getPipeline(pipelineId)),
  );

  server.registerTool(
    'simulate_route',
    {
      description: 'Return the current advisory route for a task without creating a run.',
      inputSchema: {
        title: z.string().min(1),
        repo: z.string().optional(),
        pipeline: z.string().optional(),
        playbookId: z.string().optional(),
        params: paramsSchema,
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
      description: 'Return the actionable PR feedback queue grouped by developer fixes, reviewer questions, provider waits, human decisions, ignored noise, and residual risks.',
      inputSchema: prReadinessInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => json(await facade.listPrFeedback(input)),
  );
}
