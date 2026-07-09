export type UpdateRunProfileCommandData = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  expectedProfileRevisionHash: string;
  displayName?: string;
  summary?: string;
  profile?: unknown;
  status?: 'active' | 'deprecated';
};

export class UpdateRunProfileCommand {
  constructor(readonly data: UpdateRunProfileCommandData) {}
}
