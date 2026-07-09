export type DeprecateRunProfileCommandData = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
  expectedProfileHash: string;
};

export class DeprecateRunProfileCommand {
  constructor(readonly data: DeprecateRunProfileCommandData) {}
}
