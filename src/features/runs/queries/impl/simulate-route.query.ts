export type SimulateRouteQueryData = {
  title: string;
  repo?: string;
  pipeline: string;
  profileId?: string;
  profile?: unknown;
  playbookId?: string;
  params?: unknown;
};

export class SimulateRouteQuery {
  constructor(readonly data: SimulateRouteQueryData) {}
}
