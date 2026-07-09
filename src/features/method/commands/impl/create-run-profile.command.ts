export type CreateRunProfileCommandData = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  displayName: string;
  summary?: string;
  profile: unknown;
  status?: 'active' | 'deprecated';
};

export class CreateRunProfileCommand {
  constructor(readonly data: CreateRunProfileCommandData) {}
}
