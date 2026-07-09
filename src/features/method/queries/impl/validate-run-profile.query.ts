export type ValidateRunProfileQueryData = {
  playbookId?: string;
  pipelineId: string;
  profile: unknown;
};

export class ValidateRunProfileQuery {
  constructor(readonly data: ValidateRunProfileQueryData) {}
}
