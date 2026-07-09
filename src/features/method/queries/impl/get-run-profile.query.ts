export type GetRunProfileQueryData = {
  playbookId?: string;
  pipelineId: string;
  profileId: string;
};

export class GetRunProfileQuery {
  constructor(readonly data: GetRunProfileQueryData) {}
}
