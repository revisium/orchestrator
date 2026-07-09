export type DeprecateRunProfileCommandData = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  expectedProfileRevisionHash: string;
};

export class DeprecateRunProfileCommand {
  constructor(readonly data: DeprecateRunProfileCommandData) {}
}
