import { Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { AnswerQuestionCommand } from '../impl/answer-question.command.js';
import { ApproveGateCommand } from '../impl/approve-gate.command.js';
import { RejectGateCommand } from '../impl/reject-gate.command.js';
import { ResolveInboxItemCommand } from '../impl/resolve-inbox-item.command.js';

@CommandHandler(ApproveGateCommand)
export class ApproveGateHandler implements ICommandHandler<ApproveGateCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: ApproveGateCommand) {
    return this.api.approveGate(command.data);
  }
}

@CommandHandler(RejectGateCommand)
export class RejectGateHandler implements ICommandHandler<RejectGateCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: RejectGateCommand) {
    return this.api.rejectGate(command.data);
  }
}

@CommandHandler(AnswerQuestionCommand)
export class AnswerQuestionHandler implements ICommandHandler<AnswerQuestionCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: AnswerQuestionCommand) {
    return this.api.answerQuestion(command.data);
  }
}

@CommandHandler(ResolveInboxItemCommand)
export class ResolveInboxItemHandler implements ICommandHandler<ResolveInboxItemCommand> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  execute(command: ResolveInboxItemCommand) {
    return this.api.resolveInboxItem(command.data);
  }
}
