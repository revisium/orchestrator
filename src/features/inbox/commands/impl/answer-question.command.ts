export type AnswerQuestionCommandData = {
  inboxId: string;
  answer: unknown;
  resolvedBy?: string;
};

export class AnswerQuestionCommand {
  constructor(readonly data: AnswerQuestionCommandData) {}
}
