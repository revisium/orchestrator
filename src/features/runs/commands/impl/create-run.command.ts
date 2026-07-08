export type CreateRunCommandData = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  priority?: number;
  playbookId?: string;
  pipelineId: string;
  profileId?: string;
  profile?: unknown;
  params?: unknown;
  issueRef?: unknown;
  issueAction?: unknown;
  start?: boolean;
};

export class CreateRunCommand {
  constructor(readonly data: CreateRunCommandData) {}
}
