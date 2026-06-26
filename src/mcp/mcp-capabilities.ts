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
  'observe_run',
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
  'wait_for_run',
  'wait_for_any_gate',
  'watch_runs',
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
- observe run state through the low-context observe_run contract;
- inspect bounded digests, events, attempts, agent activity, and logs only when needed;
- resolve human inbox gates and questions;
- inspect installed playbooks, roles, and pipelines;
- inspect PR readiness and actionable review feedback before resuming work;
- validate repository context before starting live work.

Preferred run observation order:
1. Use observe_run with the returned cursor for normal observation loops.
2. Use observe_run with mode:"heartbeat" for explicit liveness checks.
3. Use get_run_digest when observe_run.nextAction is "inspect_digest".
4. Use get_agent_log with offsetBytes/limitBytes or tailBytes only when observe_run.nextAction is "inspect_log" or explicit debugging requires logs.
5. Avoid get_run(includeEvents:true) and raw agent logs in polling loops.

Compatibility note: wait_for_run, wait_for_any_gate, and watch_runs remain registered for existing clients and
diagnostic scripts, but observe_run is the canonical normal observation surface.

This MCP server is local stdio only and does not expose generic Revisium table CRUD.
Use product-level tools instead of writing raw rows.`;
