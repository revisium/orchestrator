export type ListRunProfilesQueryData = {
  first?: number;
  after?: string;
  playbookId?: string;
  pipelineId?: string;
  includeDeprecated?: boolean;
};

export class ListRunProfilesQuery {
  constructor(readonly data: ListRunProfilesQueryData) {}
}
