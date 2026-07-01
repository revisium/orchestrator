import { OPERATOR_MONITORING_PROTOCOL } from './monitoring-directive.js';

export const MCP_TOOL_NAMES = [
  'get_status',
  'doctor',
  'get_capabilities',
  'validate_repository',
  'get_repository_context',
  'get_project',
  'create_run',
  'start_run',
  'resume_run',
  'get_run_attention',
  'get_run_status',
  'watch_run_changes',
  'cancel_run',
  'list_runs',
  'get_run',
  'get_run_events',
  'get_run_log',
  'get_agent_activity',
  'get_agent_attempts',
  'get_agent_log',
  'tail_agent_log',
  'read_agent_output_events',
  'get_run_digest',
  'list_inbox',
  'get_inbox_item',
  'get_pending_decisions',
  'approve_gate',
  'reject_gate',
  'resolve_gate',
  'answer_question',
  'resolve_inbox_item',
  'summarize_gate_risk',
  'install_playbook',
  'list_playbooks',
  'list_roles',
  'get_role',
  'list_pipelines',
  'get_pipeline',
  'simulate_route',
  'get_pr_readiness',
  'list_pr_feedback',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

const monitoringLoopLines = [
  'task_monitoring_loop — default agent algorithm for monitoring a run:',
  ...OPERATOR_MONITORING_PROTOCOL.map((step, i) => `${i + 1}. ${step}`),
  'Use get_run_status for neutral dashboard or status checks that must not prescribe actions.',
  'watch_run_changes is only for UI/change-stream/long-poll consumers that explicitly need cursor-based transition delivery — not for normal task monitoring.',
];

export const MCP_INSTRUCTIONS = `Revo is a local-first software-development task orchestrator.

Use these tools to manage tasks end-to-end from your coding agent. When you create or start a run, you become the operator/humanGate for that run — follow task_monitoring_loop below until nextAction is "done".
- create and start runs;
- resume terminal recoverable preflight blocks with resume_run after the target repo is repaired;
- observe run state and attention requirements through the intent-named observation tools;
- inspect bounded digests, events, attempts, agent activity, and logs only when needed;
- resolve human inbox gates and questions;
- inspect installed playbooks, roles, and pipelines;
- inspect PR readiness and actionable review feedback before resuming work;
- validate repository context before starting live work.

${monitoringLoopLines.join('\n')}

Diagnostic tools (call only when required):
- get_run_digest when nextAction is "inspect_digest".
- get_agent_log with offsetBytes/limitBytes or tailBytes when nextAction is "inspect_log" or explicit debugging requires logs.
- Avoid get_run(includeEvents:true) and raw agent logs in polling loops.

This MCP server is local stdio only and does not expose generic Revisium table CRUD.
Use product-level tools instead of writing raw rows.

create_run requires an explicit pipelineId; omit it and no run is created — you get candidatePipelines plus a best-effort wouldAutoRoute to choose from (no silent auto-routing). Use list_pipelines/simulate_route to pick.`;
