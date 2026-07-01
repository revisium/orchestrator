import { registerEnumType } from '@nestjs/graphql';
import {
  AgentActivityStatus,
  AgentLogStream,
  AgentOutputEventKind,
  AgentOutputStream,
} from './runs/model/agent-activity.model.js';
import { IssueActionEnum } from './share/model/issue-action.model.js';

export function registerGraphqlEnums(): void {
  registerEnumType(AgentLogStream, { name: 'AgentLogStream' });
  registerEnumType(AgentActivityStatus, { name: 'AgentActivityStatus' });
  registerEnumType(AgentOutputStream, { name: 'AgentOutputStream' });
  registerEnumType(AgentOutputEventKind, { name: 'AgentOutputEventKind' });
  registerEnumType(IssueActionEnum, { name: 'IssueAction' });
}
