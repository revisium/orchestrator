export type GetPipelineQueryData = {
  pipelineId: string;
};

export class GetPipelineQuery {
  constructor(readonly data: GetPipelineQueryData) {}
}
