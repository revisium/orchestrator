import { registerEnumType } from '@nestjs/graphql';
import {
  AgentActivityStatus,
  AgentLogStream,
  AgentOutputEventKind,
  AgentOutputStream,
} from './runs/model/agent-activity.model.js';
import { IssueActionEnum } from './share/model/issue-action.model.js';
import { GateReconcileInput } from './inbox/inputs/resolve-gate.input.js';

export function registerGraphqlEnums(): void {
  registerEnumType(AgentLogStream, { name: 'AgentLogStream' });
  registerEnumType(AgentActivityStatus, { name: 'AgentActivityStatus' });
  registerEnumType(AgentOutputStream, { name: 'AgentOutputStream' });
  registerEnumType(AgentOutputEventKind, { name: 'AgentOutputEventKind' });
  registerEnumType(IssueActionEnum, { name: 'IssueAction' });
  registerEnumType(GateReconcileInput, { name: 'GateReconcile' });
}
