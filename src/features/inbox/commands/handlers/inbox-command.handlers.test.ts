import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { AnswerQuestionCommand } from '../impl/answer-question.command.js';
import { ApproveGateCommand } from '../impl/approve-gate.command.js';
import { RejectGateCommand } from '../impl/reject-gate.command.js';
import { ResolveInboxItemCommand } from '../impl/resolve-inbox-item.command.js';
import {
  AnswerQuestionHandler,
  ApproveGateHandler,
  RejectGateHandler,
  ResolveInboxItemHandler,
} from './inbox-command.handlers.js';

test('inbox command handlers delegate through TaskControlPlaneApiService', async () => {
  const calls: string[] = [];
  const api = {
    async approveGate(input: unknown) {
      calls.push(`approve:${JSON.stringify(input)}`);
      return { inboxId: 'inbox_1', previousStatus: 'pending', answer: { decision: 'approve' }, signaled: true };
    },
    async rejectGate(input: unknown) {
      calls.push(`reject:${JSON.stringify(input)}`);
      return { inboxId: 'inbox_1', previousStatus: 'pending', answer: { decision: 'reject' }, signaled: true };
    },
    async answerQuestion(input: unknown) {
      calls.push(`answer:${JSON.stringify(input)}`);
      return { inboxId: 'inbox_1', previousStatus: 'pending', answer: 'yes', signaled: false };
    },
    async resolveInboxItem(input: unknown) {
      calls.push(`resolve:${JSON.stringify(input)}`);
      return { inboxId: 'inbox_1', previousStatus: 'pending', answer: { decision: 'approve' }, signaled: true };
    },
  } as unknown as TaskControlPlaneApiService;

  assert.equal((await new ApproveGateHandler(api).execute(new ApproveGateCommand({ inboxId: 'inbox_1' }))).signaled, true);
  assert.equal((await new RejectGateHandler(api).execute(new RejectGateCommand({ inboxId: 'inbox_1' }))).signaled, true);
  assert.equal((await new AnswerQuestionHandler(api).execute(new AnswerQuestionCommand({ inboxId: 'inbox_1', answer: 'yes' }))).signaled, false);
  assert.equal(
    (await new ResolveInboxItemHandler(api).execute(new ResolveInboxItemCommand({ inboxId: 'inbox_1', answer: { decision: 'approve' } }))).signaled,
    true,
  );
  assert.deepEqual(calls, [
    'approve:{"inboxId":"inbox_1"}',
    'reject:{"inboxId":"inbox_1"}',
    'answer:{"inboxId":"inbox_1","answer":"yes"}',
    'resolve:{"inboxId":"inbox_1","answer":{"decision":"approve"}}',
  ]);
});
