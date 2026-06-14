import { Injectable } from '@nestjs/common';
import {
  TaskControlPlaneApiService,
  type RepositoryContext,
  type RepositoryValidation,
} from '../task-control-plane/task-control-plane-api.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';

export type { RepositoryContext, RepositoryValidation };

@Injectable()
export class McpFacadeService {
  constructor(private readonly api: TaskControlPlaneApiService) {}

  getCapabilities() {
    return {
      transport: 'stdio',
      auth: 'none',
      tools: [...MCP_TOOL_NAMES],
      notes: [
        'Local stdio MCP server; no remote HTTP listener.',
        'Tools expose product operations, not generic Revisium row CRUD.',
        'Runs are driven by installed playbooks, pipeline catalogs, and execution profiles.',
      ],
    };
  }

  getStatus() {
    return this.api.getStatus();
  }

  doctor() {
    return this.api.doctor();
  }

  getProject() {
    return this.api.getProject();
  }

  validateRepository(input: string): Promise<RepositoryValidation> {
    return this.api.validateRepository(input);
  }

  getRepositoryContext(input: string): Promise<RepositoryContext> {
    return this.api.getRepositoryContext(input);
  }

  createRun(input: {
    title: string;
    repo: string;
    description?: string;
    scope?: string;
    playbookId?: string;
    pipelineId?: string;
    params?: Record<string, unknown>;
    priority?: number;
    start?: boolean;
  }) {
    return this.api.createRun(input);
  }

  startRun(input: { runId: string }) {
    return this.api.startRun(input);
  }

  resumeRun(input: { runId: string }) {
    return this.api.resumeRun(input);
  }

  cancelRun(runId: string) {
    return this.api.cancelRun(runId);
  }

  listRuns(filter?: { status?: string; limit?: number }) {
    return this.api.listRuns(filter);
  }

  getRun(input: { runId: string; includeEvents?: boolean; includeLog?: boolean }) {
    return this.api.getRun(input);
  }

  getRunEvents(input: { runId: string; type?: string; limit?: number }) {
    return this.api.getRunEvents(input);
  }

  getRunLog(input: { runId: string; limit?: number }) {
    return this.api.getRunLog(input);
  }

  getRunDigest(runId: string) {
    return this.api.getRunDigest(runId);
  }

  waitForRun(input: { runId: string; timeoutMs?: number; intervalMs?: number }) {
    return this.api.waitForRun(input);
  }

  listInbox(filter?: { status?: 'pending' | 'resolved'; runId?: string; limit?: number }) {
    return this.api.listInbox(filter);
  }

  getInboxItem(inboxId: string) {
    return this.api.getInboxItem(inboxId);
  }

  getPendingDecisions(runId?: string) {
    return this.api.getPendingDecisions(runId);
  }

  approveGate(input: { inboxId: string; resolvedBy?: string }) {
    return this.api.approveGate(input);
  }

  rejectGate(input: { inboxId: string; resolvedBy?: string }) {
    return this.api.rejectGate(input);
  }

  answerQuestion(input: { inboxId: string; answer: unknown; resolvedBy?: string }) {
    return this.api.answerQuestion(input);
  }

  resolveInboxItem(input: {
    inboxId: string;
    answer: unknown;
    resolvedBy?: string;
    signalGate?: boolean;
  }) {
    return this.api.resolveInboxItem(input);
  }

  summarizeGateRisk(inboxId: string) {
    return this.api.summarizeGateRisk(inboxId);
  }

  installPlaybook(input: {
    source: string;
    commit?: boolean;
    dryRun?: boolean;
    name?: string;
    version?: string;
  }) {
    return this.api.installPlaybook(input);
  }

  listPlaybooks() {
    return this.api.listPlaybooks();
  }

  listRoles() {
    return this.api.listRoles();
  }

  getRole(roleId: string) {
    return this.api.getRole(roleId);
  }

  listPipelines() {
    return this.api.listPipelines();
  }

  getPipeline(pipelineId: string) {
    return this.api.getPipeline(pipelineId);
  }

  simulateRoute(input: { title: string; repo?: string; pipeline?: string; playbookId?: string; params?: unknown }) {
    return this.api.simulateRoute(input);
  }

  getPrReadiness(input: {
    repo: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    sonarProject?: string;
    includeComments?: boolean;
    includeReviewThreads?: boolean;
  }) {
    return this.api.getPrReadiness(input);
  }

  listPrFeedback(input: {
    repo: string;
    prNumber?: number;
    headBranch?: string;
    baseBranch?: string;
    sonarProject?: string;
    includeComments?: boolean;
    includeReviewThreads?: boolean;
  }) {
    return this.api.listPrFeedback(input);
  }
}
