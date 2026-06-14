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
  'cancel_run',
  'list_runs',
  'get_run',
  'get_run_events',
  'get_run_log',
  'get_run_digest',
  'wait_for_run',
  'list_inbox',
  'get_inbox_item',
  'get_pending_decisions',
  'approve_gate',
  'reject_gate',
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

export const MCP_INSTRUCTIONS = `Revo is a local-first software-development task orchestrator.

Use these tools to manage tasks end-to-end from your coding agent:
- create and start runs;
- inspect run status, events, attempts, and digests;
- resolve human inbox gates and questions;
- inspect installed playbooks, roles, and pipelines;
- inspect PR readiness and actionable review feedback before resuming work;
- validate repository context before starting live work.

This MCP server is local stdio only and does not expose generic Revisium table CRUD.
Use product-level tools instead of writing raw rows.`;
