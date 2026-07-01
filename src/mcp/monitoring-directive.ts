export const MONITORING_POLL_TOOL = 'get_run_attention' as const;

export const MONITORING_GATE_TOOLS = [
  'get_inbox_item',
  'resolve_gate',
  'approve_gate',
  'reject_gate',
  'answer_question',
] as const;

export const MONITORING_STOP_CONDITIONS = [
  'nextAction "done" — run reached a terminal state; stop polling.',
] as const;

export const OPERATOR_MONITORING_PROTOCOL = [
  'Call get_run_attention(runId): answers "what currently requires attention?" with requiresAttention, nextAction, and suggestedTools.',
  'nextAction "wait" → sleep/backoff, re-call get_run_attention.',
  'nextAction "ask_human" → inspect and resolve the inbox item with resolve_gate for named gate outcomes, approve_gate/reject_gate for simple gates, or answer_question.',
  'nextAction "inspect_digest" → call get_run_digest once; nextAction "inspect_log" → call get_agent_log once.',
  'nextAction "done" → stop. nextAction "start_run" → call start_run.',
] as const;

export const MONITORING_CADENCE = 'Poll every 5–30 s; back off on "wait". No fixed rate — match your client sleep/schedule primitive.';

export const OPERATOR_GUIDANCE = 'You are the operator/humanGate for this run. Follow task_monitoring_loop: poll get_run_attention(runId), handle gates via inbox tools (get_inbox_item → resolve/approve/reject/answer), stop when nextAction is "done".';

export const ADVISORY_CLIENT_HINTS = {
  advisory: true as const,
  note: 'Platform hints are optional. The protocol above is the authoritative contract.',
  hints: {
    'claude-code': 'Use /loop or ScheduleWakeup to self-pace get_run_attention polls between gates.',
    codex: 'Use your sleep/wake primitive to pace get_run_attention polls.',
  },
} as const;

export type MonitoringDirective = {
  nextAction: 'monitor';
  role: 'operator/humanGate';
  runId: string;
  pollTool: typeof MONITORING_POLL_TOOL;
  cadence: string;
  protocol: readonly string[];
  gateTools: readonly string[];
  stopConditions: readonly string[];
  guidance: string;
  clientHints: typeof ADVISORY_CLIENT_HINTS;
};

export function buildMonitoringDirective(runId: string): MonitoringDirective {
  return {
    nextAction: 'monitor',
    role: 'operator/humanGate',
    runId,
    pollTool: MONITORING_POLL_TOOL,
    cadence: MONITORING_CADENCE,
    protocol: OPERATOR_MONITORING_PROTOCOL,
    gateTools: MONITORING_GATE_TOOLS,
    stopConditions: MONITORING_STOP_CONDITIONS,
    guidance: OPERATOR_GUIDANCE,
    clientHints: ADVISORY_CLIENT_HINTS,
  };
}
