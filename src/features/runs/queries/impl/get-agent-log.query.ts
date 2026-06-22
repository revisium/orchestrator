import type { AgentLogStream } from '../../../../observability/types.js';

export type GetAgentLogQueryData = {
  runId: string;
  attemptId?: string;
  stream: AgentLogStream;
  offsetBytes?: number;
  limitBytes?: number;
  tailBytes?: number;
};

export class GetAgentLogQuery {
  constructor(readonly data: GetAgentLogQueryData) {}
}
