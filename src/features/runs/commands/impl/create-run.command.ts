export type CreateRunCommandData = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  priority?: number;
  playbookId?: string;
  pipelineId?: string;
  params?: unknown;
  start?: boolean;
};

export class CreateRunCommand {
  constructor(readonly data: CreateRunCommandData) {}
}
